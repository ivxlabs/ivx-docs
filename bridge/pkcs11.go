// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

package main

/* The dozen PKCS#11 calls the bridge needs, made straight into the token's
   module without cgo — so one machine can build every platform's binary.

   The structures are laid out by hand. CK_ULONG is 8 bytes on 64-bit macOS
   and Linux but 4 on Windows, where the spec also packs every structure to
   1 byte; ulongSize and listOffset (in the per-OS dl_*.go files) carry that
   difference and nothing else does. */

import (
	"encoding/binary"
	"fmt"
	"runtime"
	"unsafe"
)

// Positions in CK_FUNCTION_LIST, in the order pkcs11f.h declares them.
const (
	fnInitialize        = 0
	fnGetSlotList       = 4
	fnGetTokenInfo      = 6
	fnOpenSession       = 12
	fnCloseSession      = 13
	fnLogin             = 18
	fnLogout            = 19
	fnGetAttributeValue = 24
	fnFindObjectsInit   = 26
	fnFindObjects       = 27
	fnFindObjectsFinal  = 28
	fnSignInit          = 42
	fnSign              = 43
	fnCount             = 44
)

const (
	ckaClass   = 0x000
	ckaLabel   = 0x003
	ckaValue   = 0x011
	ckaKeyType = 0x100
	ckaID      = 0x102

	ckoCertificate = 1
	ckoPrivateKey  = 3
	ckkRSA         = 0
	ckmRSAPKCS     = 0x0001
	ckmECDSA       = 0x1041

	ckfSerialSession = 0x4
	ckuUser          = 1
	unavailable      = ^uint64(0) >> (64 - 8*ulongSize) // CK_UNAVAILABLE_INFORMATION
)

// rv is a PKCS#11 return code.
type rv uint64

const (
	ckrOK                  rv = 0x000
	ckrDeviceRemoved       rv = 0x032
	ckrPinIncorrect        rv = 0x0a0
	ckrPinLenRange         rv = 0x0a2
	ckrPinExpired          rv = 0x0a3
	ckrPinLocked           rv = 0x0a4
	ckrTokenNotPresent     rv = 0x0e0
	ckrUserAlreadyLoggedIn rv = 0x100
	ckrAlreadyInitialized  rv = 0x191
	ckrBufferTooSmall      rv = 0x150
)

var messages = map[rv]string{
	ckrPinIncorrect:    "Wrong PIN.",
	ckrPinLocked:       "The PIN is locked. Unblock the token with its admin PIN.",
	ckrPinLenRange:     "That PIN is not the right length.",
	ckrPinExpired:      "The PIN has expired. Change it with the token's own tool first.",
	ckrTokenNotPresent: "The token was removed.",
	ckrDeviceRemoved:   "The token was removed.",
}

func (r rv) Error() string {
	if m, ok := messages[r]; ok {
		return m
	}
	return fmt.Sprintf("the token answered 0x%X", uint64(r))
}

// module is one loaded PKCS#11 library.
type module struct {
	path string
	fns  [fnCount]uintptr
}

func loadModule(path string) (*module, error) {
	handle, err := openLibrary(path)
	if err != nil {
		return nil, err
	}
	getList, err := symbol(handle, "C_GetFunctionList")
	if err != nil {
		return nil, fmt.Errorf("%s is not a PKCS#11 module", path)
	}
	var list unsafe.Pointer
	if r := call(getList, uintptr(unsafe.Pointer(&list))); r != ckrOK {
		return nil, r
	}
	m := &module{path: path}
	for i := range m.fns {
		// After the 2-byte CK_VERSION; unaligned on Windows, which amd64 and arm64 allow.
		m.fns[i] = *(*uintptr)(unsafe.Add(list, listOffset+i*int(unsafe.Sizeof(uintptr(0)))))
	}
	if r := m.call(fnInitialize, 0); r != ckrOK && r != ckrAlreadyInitialized {
		return nil, r
	}
	return m, nil
}

func (m *module) call(fn int, args ...uintptr) rv { return call(m.fns[fn], args...) }

/* ── encoding ── */

func putUlong(b []byte, v uint64) {
	if ulongSize == 4 {
		binary.LittleEndian.PutUint32(b, uint32(v))
	} else {
		binary.LittleEndian.PutUint64(b, v)
	}
}

func getUlong(b []byte) uint64 {
	if ulongSize == 4 {
		return uint64(binary.LittleEndian.Uint32(b))
	}
	return binary.LittleEndian.Uint64(b)
}

func ulong(v uint64) []byte {
	b := make([]byte, ulongSize)
	putUlong(b, v)
	return b
}

func ptr(b []byte) uintptr {
	if len(b) == 0 {
		return 0
	}
	return uintptr(unsafe.Pointer(&b[0]))
}

// attribute is one CK_ATTRIBUTE: type, then pointer, then length.
type attribute struct {
	kind  uint64
	value []byte
}

const attributeSize = ulongSize + 8 + ulongSize

// template lays attributes out as a CK_ATTRIBUTE array.
func template(attrs []attribute) []byte {
	buf := make([]byte, len(attrs)*attributeSize)
	for i, a := range attrs {
		at := buf[i*attributeSize:]
		putUlong(at, a.kind)
		binary.LittleEndian.PutUint64(at[ulongSize:], uint64(ptr(a.value)))
		putUlong(at[ulongSize+8:], uint64(len(a.value)))
	}
	return buf
}

/* ── calls ── */

func (m *module) slots() ([]uint64, error) {
	count := ulong(0)
	if r := m.call(fnGetSlotList, 1, 0, ptr(count)); r != ckrOK {
		return nil, r
	}
	n := getUlong(count)
	if n == 0 {
		return nil, nil
	}
	list := make([]byte, n*ulongSize)
	if r := m.call(fnGetSlotList, 1, ptr(list), ptr(count)); r != ckrOK {
		return nil, r
	}
	slots := make([]uint64, getUlong(count))
	for i := range slots {
		slots[i] = getUlong(list[i*ulongSize:])
	}
	return slots, nil
}

// tokenInfo returns the token's label and serial number from CK_TOKEN_INFO,
// whose first fields are label[32], manufacturerID[32], model[16] and
// serialNumber[16] — all bytes, so no padding comes before them.
func (m *module) tokenInfo(slot uint64) (label, serial string, err error) {
	info := make([]byte, 512)
	if r := m.call(fnGetTokenInfo, uintptr(slot), ptr(info)); r != ckrOK {
		return "", "", r
	}
	return trim(info[0:32]), trim(info[80:96]), nil
}

func trim(b []byte) string {
	end := len(b)
	for end > 0 && (b[end-1] == ' ' || b[end-1] == 0) {
		end--
	}
	return string(b[:end])
}

func (m *module) openSession(slot uint64) (uint64, error) {
	session := ulong(0)
	if r := m.call(fnOpenSession, uintptr(slot), ckfSerialSession, 0, 0, ptr(session)); r != ckrOK {
		return 0, r
	}
	return getUlong(session), nil
}

func (m *module) closeSession(session uint64) { m.call(fnCloseSession, uintptr(session)) }

func (m *module) login(session uint64, pin string) error {
	p := []byte(pin)
	r := m.call(fnLogin, uintptr(session), ckuUser, ptr(p), uintptr(len(p)))
	runtime.KeepAlive(p)
	if r != ckrOK && r != ckrUserAlreadyLoggedIn {
		return r
	}
	return nil
}

func (m *module) logout(session uint64) { m.call(fnLogout, uintptr(session)) }

func (m *module) find(session uint64, attrs ...attribute) ([]uint64, error) {
	t := template(attrs)
	r := m.call(fnFindObjectsInit, uintptr(session), ptr(t), uintptr(len(attrs)))
	runtime.KeepAlive(attrs)
	if r != ckrOK {
		return nil, r
	}
	defer m.call(fnFindObjectsFinal, uintptr(session))

	const max = 64
	handles, count := make([]byte, max*ulongSize), ulong(0)
	if r := m.call(fnFindObjects, uintptr(session), ptr(handles), max, ptr(count)); r != ckrOK {
		return nil, r
	}
	found := make([]uint64, getUlong(count))
	for i := range found {
		found[i] = getUlong(handles[i*ulongSize:])
	}
	return found, nil
}

// attributes reads the values of `kinds` from an object; a value the token
// will not reveal comes back nil.
func (m *module) attributes(session, object uint64, kinds ...uint64) ([][]byte, error) {
	attrs := make([]attribute, len(kinds))
	for i, k := range kinds {
		attrs[i].kind = k
	}
	// First ask how long each value is, then fetch them into buffers that size.
	t := template(attrs)
	if r := m.call(fnGetAttributeValue, uintptr(session), uintptr(object), ptr(t), uintptr(len(attrs))); r != ckrOK {
		return nil, r
	}
	for i := range attrs {
		if n := getUlong(t[i*attributeSize+ulongSize+8:]); n != unavailable {
			attrs[i].value = make([]byte, n)
		}
	}
	t = template(attrs)
	r := m.call(fnGetAttributeValue, uintptr(session), uintptr(object), ptr(t), uintptr(len(attrs)))
	runtime.KeepAlive(attrs)
	if r != ckrOK {
		return nil, r
	}
	values := make([][]byte, len(attrs))
	for i, a := range attrs {
		values[i] = a.value
	}
	return values, nil
}

func (m *module) sign(session, key, mechanism uint64, data []byte) ([]byte, error) {
	mech := template([]attribute{{kind: mechanism}}) // CK_MECHANISM has CK_ATTRIBUTE's shape
	if r := m.call(fnSignInit, uintptr(session), ptr(mech), uintptr(key)); r != ckrOK {
		return nil, r
	}
	out, size := make([]byte, 1024), ulong(1024)
	r := m.call(fnSign, uintptr(session), ptr(data), uintptr(len(data)), ptr(out), ptr(size))
	runtime.KeepAlive(data)
	if r != ckrOK {
		return nil, r
	}
	return out[:getUlong(size)], nil
}
