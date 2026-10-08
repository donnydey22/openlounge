import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { getPreview, isPublicAddress, parseMeta } from "../../server/linkPreview";

test("private / reserved addresses are blocked", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fc00::1", "fd12::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "2001:db8::1"])
    assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111"]) assert.equal(isPublicAddress(ip), true, ip);
});

test("SSRF: localhost, private IPs, credentials and odd ports never get fetched", async () => {
  let hits = 0;
  const srv = http.createServer((_q, r) => {
    hits++;
    r.writeHead(200, { "Content-Type": "text/html" }).end("<title>secret</title>");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  for (const u of [`http://127.0.0.1:${port}/`, `http://localhost:${port}/`, "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://user:pw@example.com/", "https://example.com:8443/", "file:///etc/passwd", "gopher://x/", "http://openlounge.railway.internal/"])
    assert.equal(await getPreview(u), null, u);
  assert.equal(hits, 0);
  srv.close();
});

test("parses OpenGraph / Twitter / <title> metadata and strips control/bidi characters", () => {
  const m = parseMeta(`<html><head><title>Fallback &amp; title</title>
    <meta property="og:title" content="Hello &quot;World&quot;\u202e">
    <meta name="description" content='Plain desc'>
    <meta property="og:site_name" content=YouTube>
    <meta property="og:type" content="video.other">
    <meta property="og:image" content="https://i.example.com/x.jpg"></head><body>`);
  assert.equal(m.title, 'Hello "World"');
  assert.equal(m.description, "Plain desc");
  assert.equal(m.site, "YouTube");
  assert.equal(m.image, "https://i.example.com/x.jpg");
  assert.equal(m.video, true);
  assert.equal(parseMeta("<title>Only title</title>").title, "Only title");
});
