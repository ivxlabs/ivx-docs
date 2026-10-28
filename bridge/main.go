// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* ivx/docs Sign token bridge.

   Browsers cannot talk to smart cards or USB signing tokens, so this small
   local program does it for them, through the token's PKCS#11 driver. It
   serves two endpoints and nothing else:

     GET  /certificates   the certificates on every connected token
     POST /sign           { id, pin, digest } → { signature }

   Only a 32-byte SHA-256 digest ever arrives here, the PIN is needed for
   every signature, and the private key never leaves the hardware. It
   listens on 127.0.0.1 only, answers only the origins it is told to, and
   only under its own host name, so an arbitrary web page — or a
   DNS-rebinding trick — cannot use it. */

package main

import (
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"runtime"
	"slices"
	"strings"
)

var version = "dev" // set at release time

func main() {
	var modules []string
	port := flag.Int("port", 47111, "port to listen on, at 127.0.0.1")
	origins := flag.String("origins", "https://docs.ivx.run,http://localhost:5173,http://localhost:4173", "comma-separated web origins allowed to use the bridge")
	list := flag.Bool("list", false, "print the certificates found on connected tokens, then exit")
	flag.Func("module", "path to a PKCS#11 module (repeatable); found automatically when omitted", func(s string) error {
		modules = append(modules, s)
		return nil
	})
	showVersion := flag.Bool("version", false, "print the version, then exit")
	flag.Parse()

	if *showVersion {
		fmt.Println(version)
		return
	}
	if env := os.Getenv("PKCS11_MODULE"); len(modules) == 0 && env != "" {
		modules = []string{env}
	}

	b := &Bridge{explicit: modules, Log: log.Printf}
	if *list {
		certs, err := b.Certificates()
		if err != nil {
			fatal(err)
		}
		for _, c := range certs {
			fmt.Printf("%s  %s\n", c.ID, c.Label)
		}
		if len(certs) == 0 {
			fmt.Println("No certificates found. Is the token plugged in?")
		}
		return
	}

	addr := fmt.Sprintf("127.0.0.1:%d", *port)
	fmt.Printf("ivx/docs Sign token bridge %s\n", version)
	fmt.Printf("Listening on http://%s for %s\n", addr, *origins)
	fmt.Println("Keep this window open while you sign; close it when you are done.")
	fatal(http.ListenAndServe(addr, handler(b, *port, strings.Split(*origins, ","))))
}

// fatal reports err and exits. On Windows the bridge is usually started by
// double-clicking, and its window would vanish before anyone could read why.
func fatal(err error) {
	fmt.Fprintln(os.Stderr, "Error:", err)
	if runtime.GOOS == "windows" {
		fmt.Fprint(os.Stderr, "Press Enter to close.")
		fmt.Scanln()
	}
	os.Exit(1)
}

// handler serves the two endpoints to the allowed origins, and no one else.
func handler(b *Bridge, port int, origins []string) http.Handler {
	hosts := []string{fmt.Sprintf("127.0.0.1:%d", port), fmt.Sprintf("localhost:%d", port)}
	for i := range origins {
		origins[i] = strings.TrimSpace(origins[i])
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		send := func(status int, body any) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
			json.NewEncoder(w).Encode(body)
		}
		fail := func(status int, err error) { send(status, map[string]string{"error": err.Error()}) }

		if !slices.Contains(hosts, r.Host) || !slices.Contains(origins, origin) {
			fail(http.StatusForbidden, fmt.Errorf("origin %q is not allowed; start the bridge with -origins %s", origin, origin))
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Vary", "Origin")

		switch {
		case r.Method == http.MethodOptions:
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.Header().Set("Access-Control-Allow-Private-Network", "true")
			w.WriteHeader(http.StatusNoContent)

		case r.Method == http.MethodGet && r.URL.Path == "/certificates":
			certs, err := b.Certificates()
			if err != nil {
				fail(http.StatusInternalServerError, err)
				return
			}
			send(http.StatusOK, map[string]any{"certificates": append([]Certificate{}, certs...)})

		case r.Method == http.MethodPost && r.URL.Path == "/sign":
			var req struct{ ID, Pin, Digest string }
			if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
				fail(http.StatusBadRequest, err)
				return
			}
			digest, err := base64.StdEncoding.DecodeString(req.Digest)
			if err != nil {
				fail(http.StatusBadRequest, err)
				return
			}
			sig, err := b.Sign(req.ID, req.Pin, digest)
			if err != nil {
				fail(http.StatusInternalServerError, err)
				return
			}
			send(http.StatusOK, map[string]string{"signature": base64.StdEncoding.EncodeToString(sig)})

		default:
			fail(http.StatusNotFound, fmt.Errorf("not found"))
		}
	})
}
