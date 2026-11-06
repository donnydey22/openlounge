// Synthetic Chromium media proof only. Never labels this as a physical-device/heard-audio test.
import { chromium } from "playwright";
import { build } from "esbuild";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const dir=await fs.mkdtemp(path.join(os.tmpdir(),"ol-rtc-matrix-"));
const bundle=path.join(dir,"matrix.js");
await build({entryPoints:["tests/e2e/rtc-single-pc-browser.ts"],bundle:true,platform:"browser",format:"iife",outfile:bundle});
const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",headless:true,args:["--no-sandbox","--use-fake-ui-for-media-stream","--use-fake-device-for-media-stream","--autoplay-policy=no-user-gesture-required"]});
try{
 const page=await browser.newPage();
 page.on("console",m=>console.log(m.type(),m.text()));
 await page.route("http://127.0.0.1:18766/**",r=>r.fulfill({status:200,contentType:"text/html",body:"<!doctype html><title>OL isolated synthetic RTC matrix</title>"}));
 await page.goto("http://127.0.0.1:18766/");
 if(process.env.RTC_MATRIX_CONFIG_FILE) await page.evaluate(c=>globalThis.RTC_MATRIX_CONFIG=c,JSON.parse(await fs.readFile(process.env.RTC_MATRIX_CONFIG_FILE,"utf8")));
 await page.addScriptTag({path:bundle});
 const result=await page.evaluate(()=>globalThis.runRtcMatrix());
 if(process.env.RTC_MATRIX_RESULT_FILE) await fs.writeFile(process.env.RTC_MATRIX_RESULT_FILE,JSON.stringify(result,null,2));
 console.log(JSON.stringify({synthetic:true,physicalDeviceTest:false,states:result.states,slotCounts:result.slotCounts,errors:result.errors}));
}finally{await browser.close();await fs.rm(dir,{recursive:true,force:true})}
