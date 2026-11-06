// Open Lounge-owned ICE relay. MIT Pion TURN; no Signal server/binary or coturn dependency.
package main

import (
	"crypto/hmac"
	"crypto/sha1"
	"crypto/tls"
	"encoding/base64"
	"fmt"
	turn "github.com/pion/turn/v4"
	"log"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
)

func publicPeer(_ net.Addr, ip net.IP) bool {
	if ip == nil || !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	for _, cidr := range []string{"100.64.0.0/10", "198.18.0.0/15", "192.0.0.0/24", "0.0.0.0/8"} {
		_, n, _ := net.ParseCIDR(cidr)
		if n.Contains(ip) {
			return false
		}
	}
	return true
}
func restAuth(secret string, now func() time.Time) turn.AuthHandler {
	return func(user, realm string, _ net.Addr) ([]byte, bool) {
		parts := strings.SplitN(user, ":", 2)
		if len(parts) != 2 || !strings.HasPrefix(parts[1], "call-") || len(parts[1]) > 80 {
			return nil, false
		}
		exp, e := strconv.ParseInt(parts[0], 10, 64)
		if e != nil || exp <= now().Unix() || exp > now().Unix()+86400 {
			return nil, false
		}
		mac := hmac.New(sha1.New, []byte(secret))
		_, _ = mac.Write([]byte(user))
		password := base64.StdEncoding.EncodeToString(mac.Sum(nil))
		return turn.GenerateAuthKey(user, realm, password), true
	}
}
func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
func main() {
	ip := net.ParseIP(os.Getenv("RC_TURN_PUBLIC_IP"))
	secret := os.Getenv("RC_TURN_SECRET")
	if ip == nil || len(secret) < 32 {
		log.Fatal("RC_TURN_PUBLIC_IP and strong RC_TURN_SECRET required")
	}
	addr := env("RC_TURN_LISTEN", "0.0.0.0:13478")
	realm := env("RC_TURN_REALM", "turn.openlounge.app")
	udp, e := net.ListenPacket("udp4", addr)
	if e != nil {
		log.Fatal(e)
	}
	tcp, e := net.Listen("tcp4", addr)
	if e != nil {
		log.Fatal(e)
	}
	gen := &turn.RelayAddressGeneratorPortRange{RelayAddress: ip, Address: "0.0.0.0", MinPort: 62000, MaxPort: 62999}
	listeners := []turn.ListenerConfig{{Listener: tcp, RelayAddressGenerator: gen, PermissionHandler: publicPeer}}
	if dir := os.Getenv("CREDENTIALS_DIRECTORY"); dir != "" {
		cert, e := tls.LoadX509KeyPair(filepath.Join(dir, "tls-cert"), filepath.Join(dir, "tls-key"))
		if e != nil {
			log.Fatal("TLS credentials unavailable")
		}
		tl, e := tls.Listen("tcp4", env("RC_TURN_TLS_LISTEN", "0.0.0.0:14443"), &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12})
		if e != nil {
			log.Fatal(e)
		}
		listeners = append(listeners, turn.ListenerConfig{Listener: tl, RelayAddressGenerator: gen, PermissionHandler: publicPeer})
	}
	var ready atomic.Pointer[turn.Server]
	srv, e := turn.NewServer(turn.ServerConfig{Realm: realm, AuthHandler: restAuth(secret, time.Now), QuotaHandler: func(_ string, _ string, _ net.Addr) bool {
		srv := ready.Load()
		return srv != nil && srv.AllocationCount() < 256
	}, PacketConnConfigs: []turn.PacketConnConfig{{PacketConn: udp, RelayAddressGenerator: gen, PermissionHandler: publicPeer}}, ListenerConfigs: listeners})
	if e != nil {
		log.Fatal(e)
	}
	ready.Store(srv)
	log.Print("Open Lounge Pion ICE relay ready (UDP/TCP, isolated relay range 62000-62999)")
	c := make(chan os.Signal, 1)
	signal.Notify(c, syscall.SIGINT, syscall.SIGTERM)
	<-c
	fmt.Println("relay shutdown")
	_ = srv.Close()
}
