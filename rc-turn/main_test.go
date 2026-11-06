package main

import (
	"net"
	"strconv"
	"testing"
	"time"
)

func TestPublicPeer(t *testing.T) {
	for _, s := range []string{"127.0.0.1", "10.0.0.1", "172.16.1.1", "192.168.1.1", "100.64.1.1", "198.18.0.1", "169.254.169.254", "::1", "fc00::1", "ff02::1"} {
		if publicPeer(nil, net.ParseIP(s)) {
			t.Fatal("unsafe peer", s)
		}
	}
	if !publicPeer(nil, net.ParseIP("165.232.137.71")) {
		t.Fatal("public peer rejected")
	}
}
func TestRESTExpiry(t *testing.T) {
	now := time.Unix(1794000000, 0)
	a := restAuth("test-only-secret-not-production-123456", func() time.Time { return now })
	for _, u := range []string{"bad", strconv.FormatInt(now.Unix()-1, 10) + ":call-test", strconv.FormatInt(now.Unix()+86401, 10) + ":call-test"} {
		if _, ok := a(u, "turn.openlounge.app", nil); ok {
			t.Fatal("unsafe credential accepted")
		}
	}
	if _, ok := a(strconv.FormatInt(now.Unix()+600, 10)+":call-test", "turn.openlounge.app", nil); !ok {
		t.Fatal("valid REST credential rejected")
	}
}
