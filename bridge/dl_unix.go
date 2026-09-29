// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

//go:build darwin || linux

package main

import "github.com/ebitengine/purego"

const (
	ulongSize  = 8 // CK_ULONG is unsigned long: 64 bits here
	listOffset = 8 // CK_FUNCTION_LIST's pointers are naturally aligned
)

func openLibrary(path string) (uintptr, error) {
	return purego.Dlopen(path, purego.RTLD_NOW|purego.RTLD_LOCAL)
}

func symbol(handle uintptr, name string) (uintptr, error) { return purego.Dlsym(handle, name) }

func call(fn uintptr, args ...uintptr) rv {
	r, _, _ := purego.SyscallN(fn, args...)
	return rv(r)
}
