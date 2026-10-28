// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* Sync between devices on the same network.

   The documents live in each page's own storage, so the pages are the ones
   that sync. The bridge is the part of each device that can do what a page
   cannot: announce itself on the network, find the others, and accept a
   connection. It is a relay and nothing more. What it carries between two
   pages is encrypted by those pages under a key they agreed when they were
   paired, so the bridge never sees a document, and neither does anything
   else on the Wi-Fi.

   This is the same protocol ivx/ai Chat's bridge speaks (ivxai-app,
   crates/ivxai-bridge/src/sync.rs), so one page engine drives either:

   - Discovery: mDNS, as _ivx-sync._tcp. Each device announces the app it
     syncs for, an id and a name the page chose, and lists the others it
     hears for the same app.
   - The inbox: a second listener, on every interface, that takes exactly one
     request, POST /sync/inbox, and only from private, link-local or loopback
     addresses. It never serves /certificates or /sign; those stay on loopback
     behind the origin rules. Messages wait in memory, bounded, until this
     device's page collects them.
   - The page's side, on the loopback server: start and stop, the devices
     nearby, send one message to one of them, and a long poll for whatever
     has arrived.

   Nothing is written to disk, nothing is opened until the page asks, and
   nothing leaves the local network: a peer is only ever reached at a private
   address, and only ever heard from one. */

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/libp2p/zeroconf/v2"
)

const (
	syncService = "_ivx-sync._tcp" // what devices announce themselves as, whatever the app
	syncDomain  = "local."

	// One relayed message. The page chunks anything bigger, so this is a
	// ceiling against abuse, not a working size.
	maxMessage = 4 << 20
	// Everything waiting for the page, together. Past it a sender is told to
	// come back later rather than the bridge growing without bound.
	maxInbox = 64 << 20
	// How much one poll hands back at most. At least one message always goes,
	// however large, so a big one can never wedge the queue.
	maxPoll = 16 << 20
	// How long a poll waits for something to arrive before answering empty.
	pollWait = 25 * time.Second

	maxID   = 64
	maxName = 64
)

// How long one round of listening for announcements lasts. The mDNS library
// never says when a device leaves, so each round starts afresh, and a device
// unheard for a whole round is taken to have gone.
var browseRound = 45 * time.Second

// Sync is the page's side of sync: one per bridge.
type Sync struct {
	Log func(format string, args ...any)

	ctl sync.Mutex // start and stop, one at a time
	run *syncRun

	mu      sync.Mutex // everything below
	me      *syncMe
	peers   map[string]*syncPeer
	queue   []inboxMessage
	bytes   int
	arrived chan struct{} // closed, and replaced, when something arrives or sync stops
}

type syncMe struct {
	App, ID, Name string
	Port          int
}

type syncPeer struct {
	name  string
	addrs []netip.Addr
	port  int
	seen  time.Time
	// Heard announcing itself, as opposed to only known because it wrote to
	// us. Only those are forgotten when they fall silent.
	announced bool
}

type inboxMessage struct {
	From string `json:"from"`
	Name string `json:"name"`
	Body string `json:"body"`
}

type syncRun struct {
	me     syncMe
	server *zeroconf.Server
	inbox  *http.Server
	cancel context.CancelFunc
}

func (r *syncRun) shut() {
	r.cancel()
	r.server.Shutdown()
	r.inbox.Close()
}

// onThisNetwork says whether an address is on this network, not the
// internet. Link-local IPv6 is left out on purpose: reaching one needs the
// interface it was seen on, which an HTTP URL has no portable way to carry.
func onThisNetwork(ip netip.Addr) bool {
	ip = ip.Unmap()
	if ip.Is4() {
		return ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLoopback()
	}
	return ip.IsLoopback() || ip.IsPrivate() // IsPrivate is fc00::/7 for IPv6
}

func validID(id string) bool {
	if id == "" || len(id) > maxID {
		return false
	}
	for _, c := range []byte(id) {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-') {
			return false
		}
	}
	return true
}

// cleanName cuts a display name to length and strips control characters.
func cleanName(name string) string {
	var b strings.Builder
	n := 0
	for _, c := range name {
		if unicode.IsControl(c) {
			continue
		}
		if n == maxName {
			break
		}
		b.WriteRune(c)
		n++
	}
	return strings.TrimSpace(b.String())
}

/* ── the page's routes, on loopback ───────────────────────────── */

type syncError struct {
	status int
	msg    string
}

func (e *syncError) Error() string { return e.msg }

func syncFail(status int, format string, args ...any) error {
	return &syncError{status, fmt.Sprintf(format, args...)}
}

// serve answers one of the page's /sync/ routes. The caller has already
// checked the host and the origin.
func (s *Sync) serve(w http.ResponseWriter, r *http.Request) {
	send := func(status int, body any) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(body)
	}

	var body map[string]any
	if r.Method == http.MethodPost {
		data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxMessage+64<<10))
		if err != nil {
			send(http.StatusRequestEntityTooLarge, errorBody("Message is too large."))
			return
		}
		if len(data) > 0 {
			if err := json.Unmarshal(data, &body); err != nil {
				send(http.StatusBadRequest, errorBody("Body is not JSON: "+err.Error()))
				return
			}
		}
	}
	str := func(k string) string { v, _ := body[k].(string); return v }

	var out any
	var err error
	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/sync/start":
		out, err = s.start(str("app"), str("id"), str("name"))
	case r.Method == http.MethodPost && r.URL.Path == "/sync/stop":
		out = s.stop()
	case r.Method == http.MethodGet && r.URL.Path == "/sync/peers":
		out = s.list()
	case r.Method == http.MethodPost && r.URL.Path == "/sync/send":
		if _, ok := body["body"].(string); !ok {
			err = syncFail(http.StatusBadRequest, "Nothing to send: `body` must be a string.")
			break
		}
		out, err = s.send(r.Context(), str("to"), str("body"))
	case r.Method == http.MethodGet && r.URL.Path == "/sync/poll":
		out, err = s.poll(r.Context())
	default:
		err = syncFail(http.StatusNotFound, "Sync routes: /sync/start, /sync/stop, /sync/peers, /sync/send, /sync/poll.")
	}

	var se *syncError
	switch {
	case errors.As(err, &se):
		send(se.status, errorBody(se.msg))
	case err != nil:
		send(http.StatusInternalServerError, errorBody(err.Error()))
	default:
		send(http.StatusOK, out)
	}
}

func errorBody(msg string) map[string]any {
	return map[string]any{"ok": false, "error": map[string]string{"message": msg}}
}

// start announces this device and opens the inbox. Calling it again with
// the same app, id and name is a no-op; with anything new it re-announces.
func (s *Sync) start(app, id, name string) (any, error) {
	name = cleanName(name)
	if !validID(app) || !validID(id) {
		return nil, syncFail(http.StatusBadRequest, "An app and a device id are letters, digits and dashes.")
	}
	if name == "" {
		name = "ivx/docs device"
	}
	want := syncMe{App: app, ID: id, Name: name}

	s.ctl.Lock()
	defer s.ctl.Unlock()
	if s.run != nil {
		if r := s.run.me; r.App == app && r.ID == id && r.Name == name {
			return map[string]any{"ok": true, "app": app, "id": id, "port": r.Port}, nil
		}
		s.run.shut()
		s.run = nil
	}

	run, err := s.launch(want)
	if err != nil {
		s.mu.Lock()
		s.me = nil
		s.mu.Unlock()
		return nil, syncFail(http.StatusServiceUnavailable, "Could not start sync on this network: %v", err)
	}
	s.run = run
	s.Log("%s sync on as %s (%s), inbox on port %d", app, id, name, run.me.Port)
	return map[string]any{"ok": true, "app": app, "id": id, "port": run.me.Port}, nil
}

func (s *Sync) launch(me syncMe) (*syncRun, error) {
	// Every interface, so the other devices can reach it; localOnly below is
	// what keeps the internet out.
	ln, err := net.Listen("tcp4", "0.0.0.0:0")
	if err != nil {
		return nil, err
	}
	me.Port = ln.Addr().(*net.TCPAddr).Port

	s.mu.Lock()
	s.me = &me
	if s.peers == nil {
		s.peers = map[string]*syncPeer{}
	}
	if s.arrived == nil {
		s.arrived = make(chan struct{})
	}
	s.mu.Unlock()

	// The instance carries the app too: two apps on one machine may announce
	// at once, and their names must not collide.
	text := []string{"app=" + me.App, "id=" + me.ID, "name=" + me.Name, "v=1"}
	server, err := zeroconf.Register(me.App+"-"+me.ID, syncService, syncDomain, me.Port, text, nil)
	if err != nil {
		ln.Close()
		return nil, err
	}

	inbox := &http.Server{
		Handler:           http.HandlerFunc(s.inbox),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
	}
	go inbox.Serve(localOnly{ln, s.Log})

	ctx, cancel := context.WithCancel(context.Background())
	go s.browse(ctx, me)

	return &syncRun{me: me, server: server, inbox: inbox, cancel: cancel}, nil
}

func (s *Sync) stop() any {
	s.ctl.Lock()
	if s.run != nil {
		s.run.shut()
		s.run = nil
		s.Log("sync off")
	}
	s.ctl.Unlock()

	s.mu.Lock()
	s.me = nil
	s.peers = map[string]*syncPeer{}
	s.queue, s.bytes = nil, 0
	s.wake() // a poll waiting on an inbox that is no longer there should hear so now
	s.mu.Unlock()
	return map[string]any{"ok": true}
}

// wake tells every waiting poll to look again. Called with mu held.
func (s *Sync) wake() {
	if s.arrived != nil {
		close(s.arrived)
	}
	s.arrived = make(chan struct{})
}

func (s *Sync) list() any {
	s.mu.Lock()
	defer s.mu.Unlock()
	peers := []map[string]any{}
	for id, p := range s.peers {
		addrs := []string{}
		for _, a := range p.addrs {
			addrs = append(addrs, a.String())
		}
		peers = append(peers, map[string]any{
			"id": id, "name": p.name, "port": p.port, "addrs": addrs,
			"seenAgo": int(time.Since(p.seen).Seconds()), "announced": p.announced,
		})
	}
	out := map[string]any{"ok": true, "running": s.me != nil, "app": nil, "id": nil, "port": nil, "peers": peers}
	if s.me != nil {
		out["app"], out["id"], out["port"] = s.me.App, s.me.ID, s.me.Port
	}
	return out
}

// The client for bridge-to-bridge calls. Never through a proxy, which would
// carry a local message off the network, and quick to give up on a device
// that has wandered off.
var lanClient = &http.Client{
	Timeout: 60 * time.Second,
	Transport: &http.Transport{
		Proxy:       nil,
		DialContext: (&net.Dialer{Timeout: 3 * time.Second}).DialContext,
	},
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

// send hands one message to one device's inbox.
func (s *Sync) send(ctx context.Context, to, body string) (any, error) {
	s.mu.Lock()
	me, peer := s.me, s.peers[to]
	var addrs []netip.Addr
	var port int
	if peer != nil {
		addrs, port = slices.Clone(peer.addrs), peer.port
	}
	s.mu.Unlock()
	if me == nil {
		return nil, syncFail(http.StatusConflict, "Sync is not started.")
	}
	if peer == nil {
		return nil, syncFail(http.StatusNotFound, "That device is not on this network right now.")
	}

	envelope, _ := json.Marshal(map[string]any{
		"v": 1, "app": me.App, "from": me.ID, "name": me.Name, "port": me.Port, "to": to, "body": body,
	})
	// IPv4 first: it is what home networks actually route between devices.
	addrs = slices.DeleteFunc(addrs, func(ip netip.Addr) bool { return !onThisNetwork(ip) })
	slices.SortStableFunc(addrs, func(a, b netip.Addr) int {
		switch {
		case a.Unmap().Is4() == b.Unmap().Is4():
			return 0
		case a.Unmap().Is4():
			return -1
		}
		return 1
	})

	last := "no address on this network"
	for _, ip := range addrs {
		url := fmt.Sprintf("http://%s/sync/inbox", netip.AddrPortFrom(ip, uint16(port)))
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, url, strings.NewReader(string(envelope)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Ivx-Sync", "1")
		req.Header.Set("User-Agent", "ivx-docs-bridge/"+version)
		res, err := lanClient.Do(req)
		if err != nil {
			last = fmt.Sprintf("%s: %v", ip, err)
			continue
		}
		res.Body.Close()
		switch {
		case res.StatusCode >= 200 && res.StatusCode < 300:
			s.mu.Lock()
			if p := s.peers[to]; p != nil {
				p.seen = time.Now()
			}
			s.mu.Unlock()
			return map[string]any{"ok": true}, nil
		case res.StatusCode == http.StatusServiceUnavailable:
			return nil, syncFail(http.StatusServiceUnavailable, "That device is busy; try again shortly.")
		}
		last = fmt.Sprintf("%s answered %d", ip, res.StatusCode)
	}
	return nil, syncFail(http.StatusBadGateway, "Could not reach that device (%s).", last)
}

// poll waits for messages, and hands back what has arrived.
func (s *Sync) poll(ctx context.Context) (any, error) {
	s.mu.Lock()
	if s.me == nil {
		s.mu.Unlock()
		return nil, syncFail(http.StatusConflict, "Sync is not started.")
	}
	// Taken before the queue is looked at, so a message that lands in
	// between still wakes this poll.
	arrived, empty := s.arrived, len(s.queue) == 0
	s.mu.Unlock()

	if empty {
		timer := time.NewTimer(pollWait)
		select {
		case <-arrived:
		case <-timer.C:
		case <-ctx.Done():
		}
		timer.Stop()
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.me == nil {
		return nil, syncFail(http.StatusConflict, "Sync is not started.")
	}
	out := []inboxMessage{}
	taken := 0
	for len(s.queue) > 0 {
		size := len(s.queue[0].Body) + 256
		if len(out) > 0 && taken+size > maxPoll {
			break
		}
		taken += size
		out = append(out, s.queue[0])
		s.queue = s.queue[1:]
	}
	s.bytes -= taken
	return map[string]any{"ok": true, "messages": out}, nil
}

/* ── discovery ────────────────────────────────────────────────── */

func (s *Sync) browse(ctx context.Context, me syncMe) {
	for ctx.Err() == nil {
		began := time.Now()
		round, cancel := context.WithTimeout(ctx, browseRound)
		entries := make(chan *zeroconf.ServiceEntry, 16)
		go func() {
			for e := range entries {
				s.heard(me, e)
			}
		}()
		if err := zeroconf.Browse(round, syncService, syncDomain, entries); err != nil {
			s.Log("sync: cannot listen for other devices: %v", err)
			select {
			case <-ctx.Done():
			case <-time.After(10 * time.Second):
			}
		} else {
			<-round.Done()
		}
		cancel()
		if ctx.Err() != nil {
			return
		}
		// Every device still there answered this round's query; one that
		// was last heard before the previous round began has left.
		s.mu.Lock()
		for id, p := range s.peers {
			if p.announced && p.seen.Before(began.Add(-browseRound)) {
				delete(s.peers, id)
			}
		}
		s.mu.Unlock()
	}
}

func (s *Sync) heard(me syncMe, e *zeroconf.ServiceEntry) {
	txt := map[string]string{}
	for _, kv := range e.Text {
		if k, v, ok := strings.Cut(kv, "="); ok {
			txt[k] = v
		}
	}
	id := txt["id"]
	if txt["app"] != me.App || !validID(id) || id == me.ID {
		return
	}
	var addrs []netip.Addr
	for _, ip := range slices.Concat(e.AddrIPv4, e.AddrIPv6) {
		if a, ok := netip.AddrFromSlice(ip); ok && onThisNetwork(a) {
			addrs = append(addrs, a.Unmap())
		}
	}
	if len(addrs) == 0 || e.Port <= 0 || e.Port > 65535 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.peers[id] = &syncPeer{name: cleanName(txt["name"]), addrs: addrs, port: e.Port, seen: time.Now(), announced: true}
}

/* ── the inbox, on the network ────────────────────────────────── */

// localOnly drops connections from outside this network before a single
// byte of a request is read.
type localOnly struct {
	net.Listener
	log func(format string, args ...any)
}

func (l localOnly) Accept() (net.Conn, error) {
	for {
		c, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		if ap, err := netip.ParseAddrPort(c.RemoteAddr().String()); err == nil && onThisNetwork(ap.Addr()) {
			return c, nil
		}
		l.log("sync: refused %s (not on this network)", c.RemoteAddr())
		c.Close()
	}
}

// inbox is POST /sync/inbox, from another bridge.
//
// No CORS on this listener at all, and a custom header required: a web page
// in someone's browser on the same network cannot post here without a
// preflight, and the preflight is refused.
func (s *Sync) inbox(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || r.URL.Path != "/sync/inbox" {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	if r.Header.Get("X-Ivx-Sync") != "1" {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	var msg struct {
		App, From, To, Name string
		Body                *string
		Port                *int
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxMessage+64<<10)).Decode(&msg); err != nil {
		w.WriteHeader(http.StatusRequestEntityTooLarge)
		return
	}
	from, err := netip.ParseAddrPort(r.RemoteAddr)
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.me == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	if msg.Body == nil || msg.Port == nil || *msg.Port <= 0 || *msg.Port > 65535 || !validID(msg.From) || msg.From == s.me.ID {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	// Meant for another app on this machine, or for whoever had this address
	// before us.
	if msg.App != s.me.App || msg.To != s.me.ID {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	size := len(*msg.Body) + 256
	if s.bytes+size > maxInbox {
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	name := cleanName(msg.Name)
	s.bytes += size
	s.queue = append(s.queue, inboxMessage{From: msg.From, Name: name, Body: *msg.Body})

	// A device that wrote to us can be written back to, even when its own
	// announcements never reach us: a phone that cannot hear multicast still
	// gets answers this way.
	p := s.peers[msg.From]
	if p == nil {
		p = &syncPeer{name: name}
		s.peers[msg.From] = p
	}
	if ip := from.Addr().Unmap(); !slices.Contains(p.addrs, ip) {
		p.addrs = append([]netip.Addr{ip}, p.addrs...)
	}
	p.port, p.seen = *msg.Port, time.Now()
	if name != "" {
		p.name = name
	}

	s.wake()
	w.WriteHeader(http.StatusAccepted)
}
