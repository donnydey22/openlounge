package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func testCertificate(t *testing.T, dir string, serial int64) []byte {
	t.Helper()
	key, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(serial), Subject: pkix.Name{CommonName: "localhost"}, DNSNames: []string{"localhost"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, BasicConstraintsValid: true}
	raw, e := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if e != nil {
		t.Fatal(e)
	}
	der, e := x509.MarshalECPrivateKey(key)
	if e != nil {
		t.Fatal(e)
	}
	cert := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: raw})
	if e = os.WriteFile(filepath.Join(dir, "fullchain.pem"), cert, 0600); e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(filepath.Join(dir, "privkey.pem"), pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der}), 0600); e != nil {
		t.Fatal(e)
	}
	return cert
}
func TestCertificateReloadPreservesValidContext(t *testing.T) {
	dir := t.TempDir()
	one := filepath.Join(dir, "one")
	two := filepath.Join(dir, "two")
	os.Mkdir(one, 0700)
	os.Mkdir(two, 0700)
	ca1 := testCertificate(t, one, 1)
	ca2 := testCertificate(t, two, 2)
	current := filepath.Join(dir, "current")
	os.Symlink(one, current)
	c := &certificateReloader{directory: current, certName: "fullchain.pem", keyName: "privkey.pem"}
	if e := c.reload(); e != nil {
		t.Fatal(e)
	}
	listener, e := tls.Listen("tcp4", "127.0.0.1:0", &tls.Config{GetCertificate: c.get, MinVersion: tls.VersionTLS12})
	if e != nil {
		t.Fatal(e)
	}
	defer listener.Close()
	go func() {
		for {
			p, e := listener.Accept()
			if e != nil {
				return
			}
			go func(p net.Conn) { defer p.Close(); p.SetDeadline(time.Now().Add(time.Second)); p.Write([]byte("ok")) }(p)
		}
	}()
	check := func(ca []byte) error {
		roots := x509.NewCertPool()
		roots.AppendCertsFromPEM(ca)
		p, e := tls.Dial("tcp4", listener.Addr().String(), &tls.Config{RootCAs: roots, ServerName: "localhost", MinVersion: tls.VersionTLS12})
		if e == nil {
			p.Close()
		}
		return e
	}
	if e := check(ca1); e != nil {
		t.Fatal(e)
	}
	os.WriteFile(filepath.Join(one, "privkey.pem"), []byte("invalid"), 0600)
	if c.reload() == nil {
		t.Fatal("invalid pair accepted")
	}
	if e := check(ca1); e != nil {
		t.Fatalf("old context not retained: %v", e)
	}
	os.Symlink(two, filepath.Join(dir, "next"))
	os.Rename(filepath.Join(dir, "next"), current)
	if e := c.reload(); e != nil {
		t.Fatal(e)
	}
	if e := check(ca2); e != nil {
		t.Fatal(e)
	}
	if check(ca1) == nil {
		t.Fatal("old CA accepted renewed peer")
	}
}
