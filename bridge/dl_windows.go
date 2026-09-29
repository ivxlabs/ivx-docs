// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

package main

import "syscall"

const (
	ulongSize  = 4 // CK_ULONG is unsigned long: 32 bits on Windows
	listOffset = 2 // structures are packed to 1 byte, so pointers follow CK_VERSION directly
)

func openLibrary(path string) (uintptr, error) {
	h, err := syscall.LoadLibrary(path)
	return uintptr(h), err
}

func symbol(handle uintptr, name string) (uintptr, error) {
	return syscall.GetProcAddress(syscall.Handle(handle), name)
}

func call(fn uintptr, args ...uintptr) rv {
	r, _, _ := syscall.SyscallN(fn, args...)
	return rv(uint32(r))
}
