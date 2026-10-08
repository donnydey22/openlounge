// Tiny ES5 polyfills inlined first in <head> for old WebViews (Android 7+ stock WebView = Chrome 69+), before any
// Next/Turbopack chunk runs. Syntax is lowered by the browserslist in package.json; this only fills runtime APIs the
// bundles use unguarded. Every block feature-checks first, so modern browsers just run a handful of `if`s.
export const legacyPolyfills = `(function(){try{
var g=typeof globalThis!=="undefined"?globalThis:typeof self!=="undefined"?self:window;
if(typeof globalThis==="undefined"){Object.defineProperty(Object.prototype,"__ol_g",{get:function(){return this},configurable:true});__ol_g.globalThis=__ol_g;delete Object.prototype.__ol_g;if(typeof globalThis==="undefined")g.globalThis=g;}
var d=function(o,k,v){if(!o[k])Object.defineProperty(o,k,{value:v,writable:true,configurable:true});};
d(g,"queueMicrotask",function(f){Promise.resolve().then(f).catch(function(e){setTimeout(function(){throw e})})});
d(Object,"hasOwn",function(o,k){return Object.prototype.hasOwnProperty.call(Object(o),k)});
d(Object,"fromEntries",function(it){var o={};Array.from(it,function(e){o[e[0]]=e[1]});return o});
var at=function(i){i=Math.trunc(i)||0;if(i<0)i+=this.length;return i<0||i>=this.length?undefined:this[i]};
d(Array.prototype,"at",at);d(String.prototype,"at",at);
if(typeof Int8Array!=="undefined")d(Object.getPrototypeOf(Int8Array.prototype),"at",at);
d(Promise,"allSettled",function(ps){return Promise.all(Array.from(ps,function(p){return Promise.resolve(p).then(function(v){return{status:"fulfilled",value:v}},function(r){return{status:"rejected",reason:r}})}))});
d(String.prototype,"replaceAll",function(s,r){if(s instanceof RegExp){if(!s.global)throw new TypeError("replaceAll must be called with a global RegExp");return this.replace(s,r)}return this.split(String(s)).join(typeof r==="function"?r(String(s)):String(r).replace(/\\$\\$/g,"$"))});
d(String.prototype,"matchAll",function(re){var r=new RegExp(re,(re&&re.flags)||"g"),s=String(this),out=[],m;if(!r.global)throw new TypeError("matchAll requires a global RegExp");while((m=r.exec(s))!==null){out.push(m);if(m[0]==="")r.lastIndex++}return out[Symbol.iterator]()});
if(g.crypto&&!g.crypto.randomUUID&&g.crypto.getRandomValues)g.crypto.randomUUID=function(){var b=g.crypto.getRandomValues(new Uint8Array(16));b[6]=b[6]&15|64;b[8]=b[8]&63|128;var h=[];for(var i=0;i<16;i++)h.push((b[i]+256).toString(16).slice(1));return h.slice(0,4).join("")+"-"+h.slice(4,6).join("")+"-"+h.slice(6,8).join("")+"-"+h.slice(8,10).join("")+"-"+h.slice(10).join("")};
d(g,"structuredClone",function c(v,seen){seen=seen||new Map();if(v===null||typeof v!=="object")return v;if(seen.has(v))return seen.get(v);var o;if(v instanceof Date)return new Date(v.getTime());if(v instanceof RegExp)return new RegExp(v.source,v.flags);if(ArrayBuffer.isView(v))return v.slice();if(v instanceof ArrayBuffer)return v.slice(0);if(v instanceof Map){o=new Map();seen.set(v,o);v.forEach(function(x,k){o.set(c(k,seen),c(x,seen))});return o}if(v instanceof Set){o=new Set();seen.set(v,o);v.forEach(function(x){o.add(c(x,seen))});return o}o=Array.isArray(v)?[]:{};seen.set(v,o);Object.keys(v).forEach(function(k){o[k]=c(v[k],seen)});return o});
if(g.AbortSignal&&!AbortSignal.timeout&&g.AbortController)AbortSignal.timeout=function(ms){var c=new AbortController();setTimeout(function(){try{c.abort(new DOMException("signal timed out","TimeoutError"))}catch(e){c.abort()}},ms);return c.signal};
}catch(e){}
try{if(!(g.CSS&&CSS.supports&&CSS.supports("aspect-ratio","1/1"))){var de=document.documentElement,t=document.createElement("div");t.style.cssText="display:flex;flex-direction:column;row-gap:1px;position:absolute;visibility:hidden";t.appendChild(document.createElement("div"));t.appendChild(document.createElement("div"));de.appendChild(t);var fg=t.scrollHeight===1;de.removeChild(t);if(!fg){de.setAttribute("data-noflexgap","");
var tx=function(n,k){while(n&&n.nodeType===3&&!n.nodeValue.trim())n=n[k];return n&&n.nodeType===3},
kids=function(p){if(!p||!p.children)return;for(var i=0;i<p.children.length;i++){var e=p.children[i];if(tx(e.nextSibling,"nextSibling")){if(!e.hasAttribute("data-gn"))e.setAttribute("data-gn","")}if(tx(e.previousSibling,"previousSibling")){if(!e.hasAttribute("data-gp"))e.setAttribute("data-gp","")}}},
todo=[],raf=0,run=function(){raf=0;var l=todo;todo=[];for(var i=0;i<l.length;i++){var r=l[i];if(!r.isConnected&&r!==de)continue;kids(r);var d=r.querySelectorAll("*");for(var j=0;j<d.length;j++)kids(d[j])}},
q=function(n){if(n&&n.nodeType===1){todo.push(n);raf=raf||requestAnimationFrame(run)}};
new MutationObserver(function(ms){for(var i=0;i<ms.length;i++){var m=ms[i];if(m.type==="characterData")q(m.target.parentNode&&m.target.parentNode.parentNode);else{q(m.target.parentNode||m.target);for(var j=0;j<m.addedNodes.length;j++)if(m.addedNodes[j].nodeType===1)q(m.addedNodes[j])}}}).observe(de,{childList:true,subtree:true,characterData:true});q(de)}}}catch(e){}})();`;
