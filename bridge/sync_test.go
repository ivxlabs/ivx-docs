// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"
)

func TestOnlyLocalAddressesCountAsThisNetwork(t *testing.T) {
	for _, ok := range []string{"192.168.1.20", "10.0.0.5", "172.16.3.4", "169.254.1.1", "127.0.0.1", "::1", "fd12::1", "::ffff:192.168.0.9"} {
		if !onThisNetwork(netip.MustParseAddr(ok)) {
			t.Errorf("%s should count", ok)
		}
	}
	for _, no := range []string{"8.8.8.8", "172.32.0.1", "2001:4860::1", "fe80::1", "::ffff:1.1.1.1"} {
		if onThisNetwork(netip.MustParseAddr(no)) {
			t.Errorf("%s should not count", no)
		}
	}
}

func TestIdsAndNamesAreHeldToAShape(t *testing.T) {
	if !validID("a1b2-c3") || validID("") || validID("../etc") || validID(strings.Repeat("a", 65)) {
		t.Error("validID")
	}
	if got := cleanName("  Vi's\n Mac\x07  "); got != "Vi's Mac" {
		t.Errorf("cleanName: %q", got)
	}
	if got := cleanName(strings.Repeat("x", 200)); len(got) != maxName {
		t.Errorf("cleanName length: %d", len(got))
	}
}

// node is one device's hub with its inbox served on loopback, as if sync had
// been started, minus mDNS: peers are introduced by hand.
func node(t *testing.T, app, id string) (*Sync, int) {
	s := &Sync{Log: t.Logf, peers: map[string]*syncPeer{}, arrived: make(chan struct{})}
	srv := httptest.NewServer(http.HandlerFunc(s.inbox))
	t.Cleanup(srv.Close)
	port := netip.MustParseAddrPort(srv.Listener.Addr().String()).Port()
	s.me = &syncMe{App: app, ID: id, Name: id + "'s device", Port: int(port)}
	return s, int(port)
}

func introduce(a *Sync, b *Sync) {
	a.peers[b.me.ID] = &syncPeer{name: b.me.Name, addrs: []netip.Addr{netip.MustParseAddr("127.0.0.1")}, port: b.me.Port, announced: true}
}

func TestRelaysAMessageAndLearnsTheSender(t *testing.T) {
	a, _ := node(t, "ivx-docs", "aaaa")
	b, _ := node(t, "ivx-docs", "bbbb")
	introduce(a, b)

	got := make(chan any, 1)
	go func() {
		out, err := b.poll(context.Background())
		if err != nil {
			t.Error(err)
		}
		got <- out
	}()
	time.Sleep(50 * time.Millisecond) // let the poll start waiting
	if _, err := a.send(context.Background(), "bbbb", "sealed"); err != nil {
		t.Fatal(err)
	}

	select {
	case out := <-got:
		msgs := out.(map[string]any)["messages"].([]inboxMessage)
		if len(msgs) != 1 || msgs[0].From != "aaaa" || msgs[0].Body != "sealed" || msgs[0].Name != "aaaa's device" {
			t.Fatalf("got %+v", msgs)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the poll never woke")
	}

	// B never heard A announce itself, but can write back all the same.
	if p := b.peers["aaaa"]; p == nil || p.announced || p.port != a.me.Port {
		t.Fatalf("B did not learn A: %+v", p)
	}
	if _, err := b.send(context.Background(), "aaaa", "reply"); err != nil {
		t.Fatal(err)
	}
	if len(a.queue) != 1 || a.queue[0].Body != "reply" {
		t.Fatalf("A's inbox: %+v", a.queue)
	}
}

func TestRefusesAnotherAppsMessages(t *testing.T) {
	a, _ := node(t, "ivxai", "aaaa")
	b, _ := node(t, "ivx-docs", "bbbb")
	introduce(a, b)
	_, err := a.send(context.Background(), "bbbb", "sealed")
	if se, ok := err.(*syncError); !ok || se.status != http.StatusBadGateway {
		t.Fatalf("sent across apps: %v", err)
	}
	if len(b.queue) != 0 {
		t.Fatal("B took a message meant for another app")
	}
}

func TestInboxWantsItsHeaderAndAFullEnvelope(t *testing.T) {
	b, port := node(t, "ivx-docs", "bbbb")
	url := "http://127.0.0.1:" + itoa(port) + "/sync/inbox"
	post := func(body string, header bool) int {
		req, _ := http.NewRequest(http.MethodPost, url, strings.NewReader(body))
		if header {
			req.Header.Set("X-Ivx-Sync", "1")
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	envelope := func(m map[string]any) string { j, _ := json.Marshal(m); return string(j) }
	full := map[string]any{"v": 1, "app": "ivx-docs", "from": "aaaa", "to": "bbbb", "port": 9, "body": "x"}

	if c := post(envelope(full), false); c != http.StatusForbidden {
		t.Errorf("without the header: %d", c)
	}
	for _, drop := range []string{"body", "port", "from"} {
		m := map[string]any{}
		for k, v := range full {
			if k != drop {
				m[k] = v
			}
		}
		if c := post(envelope(m), true); c != http.StatusBadRequest {
			t.Errorf("without %s: %d", drop, c)
		}
	}
	if c := post(envelope(map[string]any{"v": 1, "app": "ivx-docs", "from": "aaaa", "to": "cccc", "port": 9, "body": "x"}), true); c != http.StatusNotFound {
		t.Errorf("for someone else: %d", c)
	}
	if c := post(envelope(full), true); c != http.StatusAccepted {
		t.Errorf("a good one: %d", c)
	}
	if len(b.queue) != 1 {
		t.Fatalf("queue: %+v", b.queue)
	}
}

func TestSyncRoutesFollowTheOriginRulesAndCanBeTurnedOff(t *testing.T) {
	ask := func(s *Sync, origin string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/sync/peers", nil)
		req.Host = "127.0.0.1:47111"
		req.Header.Set("Origin", origin)
		res := httptest.NewRecorder()
		handler(&Bridge{}, s, 47111, []string{"https://docs.ivx.run"}).ServeHTTP(res, req)
		return res
	}
	if res := ask(&Sync{}, "https://evil.example"); res.Code != http.StatusForbidden {
		t.Errorf("another origin: %d", res.Code)
	}
	if res := ask(&Sync{}, "https://docs.ivx.run"); res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"running":false`) {
		t.Errorf("allowed: %d %s", res.Code, res.Body)
	}
	if res := ask(nil, "https://docs.ivx.run"); res.Code != http.StatusForbidden {
		t.Errorf("-no-sync: %d", res.Code)
	}
}

func itoa(n int) string { j, _ := json.Marshal(n); return string(j) }
