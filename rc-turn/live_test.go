package main

import (
	"crypto/hmac"
	"crypto/sha1"
	"crypto/tls"
	"encoding/base64"
	turn "github.com/pion/turn/v4"
	"net"
	"os"
	"strconv"
	"testing"
	"time"
)

// Explicit opt-in integration test; only run on designated DO using its local service environment.
func TestLiveTwoPeerRelay(t *testing.T) {
	addr := os.Getenv("RC_TURN_TEST_ADDR")
	if addr == "" {
		t.Skip("explicit candidate relay address required")
	}
	secret := os.Getenv("RC_TURN_SECRET")
	if len(secret) < 32 {
		t.Fatal("candidate secret missing")
	}
	user := strconv.FormatInt(time.Now().Unix()+600, 10) + ":call-relay-proof"
	m := hmac.New(sha1.New, []byte(secret))
	m.Write([]byte(user))
	pass := base64.StdEncoding.EncodeToString(m.Sum(nil))
	makePeer := func() (net.PacketConn, *turn.Client) {
		var raw net.Conn
		var e error
		if os.Getenv("RC_TURN_TEST_TLS") == "1" {
			raw, e = tls.DialWithDialer(&net.Dialer{Timeout: 5 * time.Second}, "tcp4", addr, &tls.Config{ServerName: "turn.openlounge.app", MinVersion: tls.VersionTLS12})
		} else {
			raw, e = net.DialTimeout("tcp4", addr, 5*time.Second)
		}
		if e != nil {
			t.Fatal(e)
		}
		c, e := turn.NewClient(&turn.ClientConfig{TURNServerAddr: addr, Username: user, Password: pass, Realm: "turn.openlounge.app", Conn: turn.NewSTUNConn(raw), RTO: time.Second})
		if e != nil {
			t.Fatal(e)
		}
		if e = c.Listen(); e != nil {
			t.Fatal(e)
		}
		p, e := c.Allocate()
		if e != nil {
			t.Fatal(e)
		}
		return p, c
	}
	a, ca := makePeer()
	defer ca.Close()
	defer a.Close()
	b, cb := makePeer()
	defer cb.Close()
	defer b.Close()
	// Both peers establish TURN permissions before checking payloads.
	b.WriteTo([]byte("prime"), a.LocalAddr())
	a.WriteTo([]byte("a-to-b"), b.LocalAddr())
	b.SetReadDeadline(time.Now().Add(5 * time.Second))
	buf := make([]byte, 1500)
	n, _, e := b.ReadFrom(buf)
	if e != nil || string(buf[:n]) != "a-to-b" {
		t.Fatal("A->B relay failed", e)
	}
	a.SetReadDeadline(time.Now().Add(5 * time.Second))
	b.WriteTo([]byte("b-to-a"), a.LocalAddr())
	for {
		n, _, e = a.ReadFrom(buf)
		if e != nil {
			t.Fatal("B->A relay failed", e)
		}
		if string(buf[:n]) == "b-to-a" {
			break
		}
	}
	t.Log("Authenticated two-peer TURN/TCP allocation and bidirectional relayed payloads PASS")
}
