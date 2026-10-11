/**
 * A FIXED component catalog an agent composes an answer from (epic #188930, gap #1).
 *
 * The model picks parts and wires them to bound data; it does not write markup. That is the
 * difference between "a page the model wrote" (anything, any quality, any brand) and "an answer
 * built from our parts" (the same table, the same stat, every time). The spec is JSON; the
 * renderer is a small runtime inlined into the same sandboxed frame as every other artifact, so
 * it inherits ADR-01 (sandbox, CSP, no network) and reads data through the same iris.data block.
 *
 * Interactivity runs in the frame: a Slider sets a variable, every Stat that names it recomputes.
 * No model call, no network — the property a chat answer needs to be a tool and not a picture.
 *
 * Validation happens HERE, before anything is written: an unknown component, a `from` that names
 * no binding, or a formula that is not arithmetic fails the tool call with the list of what is
 * allowed. A spec the runtime cannot draw must never reach the frame as a blank box.
 */

export type UiNode = { type: string; props?: Record<string, unknown>; children?: UiNode[] }

/** The catalog, as the tool description tells it to the model. Keep this the one list. */
export const CATALOG: Record<string, string> = {
  Heading: "text, level (1-3)",
  Text: "text",
  Stat: 'label, and value | {from, field, agg: count|sum|avg|min|max} | formula ("seats * 29"), optional prefix/suffix',
  Table:
    "from, columns [field | {field, label}], optional search (true), sort (field, numbers high→low), limit (default 25, then Show all)",
  BarChart: "from, x (field), y (field), optional agg (sum|count|avg) when x repeats",
  Slider: "name, label, min, max, step, value — sets a variable formulas can use",
  Row: "children (laid out side by side)",
  Card: "title, children",
  Link: "text, href (https:// only — opens outside the app)",
}

const AGGS = new Set(["count", "sum", "avg", "min", "max"])

/** Arithmetic only: numbers, slider names, + - * / ( ) and spaces. No calls, no members, no strings. */
// Token by token, not character by character: "." is only legal inside a number, so
// "window.top" is refused even though every one of its characters is allowed somewhere.
const FORMULA_SAFE = /^(?:\s*(?:\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_]*|[-+*/()]))*\s*$/
const FORMULA_NAMES = /[A-Za-z_][A-Za-z0-9_]*/g

export class SpecError extends Error {}

/** Throws SpecError with an actionable message. */
export function validateSpec(nodes: unknown, bindingNames: string[]): void {
  if (!Array.isArray(nodes) || !nodes.length) throw new SpecError("components must be a non-empty array")
  const vars = new Set<string>()
  const walk = (n: unknown, path: string, visit: (node: UiNode, path: string) => void) => {
    if (!n || typeof n !== "object" || Array.isArray(n))
      throw new SpecError(`${path}: a component is an object {type, props}`)
    const node = n as UiNode
    if (typeof node.type !== "string" || !(node.type in CATALOG)) {
      throw new SpecError(
        `${path}: unknown component "${String(node.type)}". Use one of: ${Object.keys(CATALOG).join(", ")}`,
      )
    }
    visit(node, path)
    if (node.children !== undefined) {
      if (!Array.isArray(node.children)) throw new SpecError(`${path}.children must be an array`)
      node.children.forEach((c, i) => walk(c, `${path}.children[${i}]`, visit))
    }
  }
  // first pass: collect slider variables (a formula may use one declared later on the page)
  nodes.forEach((n, i) =>
    walk(n, `components[${i}]`, (node) => {
      if (node.type === "Slider") {
        const name = node.props?.name
        if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
          throw new SpecError(`Slider needs a name (an identifier)`)
        vars.add(name)
      }
    }),
  )
  nodes.forEach((n, i) =>
    walk(n, `components[${i}]`, (node, path) => {
      const p = node.props ?? {}
      const from =
        (p as any).from ??
        ((p as any).value && typeof (p as any).value === "object" ? (p as any).value.from : undefined)
      if (from !== undefined && !bindingNames.includes(String(from))) {
        throw new SpecError(
          `${path}: from "${String(from)}" is not a binding. Bound: ${bindingNames.join(", ") || "none — add bindings"}`,
        )
      }
      if (["Table", "BarChart"].includes(node.type) && from === undefined)
        throw new SpecError(`${path}: ${node.type} needs from`)
      if (node.type === "BarChart" && (typeof p.x !== "string" || typeof p.y !== "string")) {
        throw new SpecError(`${path}: BarChart needs x and y (field names)`)
      }
      if (node.type === "Stat" && p.value && typeof p.value === "object") {
        const agg = (p.value as any).agg
        if (!AGGS.has(agg)) throw new SpecError(`${path}: agg must be one of ${[...AGGS].join(", ")}`)
      }
      if (node.type === "Stat" && p.formula !== undefined) {
        const f = String(p.formula)
        if (!FORMULA_SAFE.test(f))
          throw new SpecError(`${path}: formula may contain only numbers, slider names and + - * / ( )`)
        for (const name of f.match(FORMULA_NAMES) ?? []) {
          if (!vars.has(name)) throw new SpecError(`${path}: formula uses "${name}", which no Slider defines`)
        }
      }
      if (node.type === "Link" && !/^https:\/\//.test(String(p.href ?? "")))
        throw new SpecError(`${path}: Link href must be https://`)
    }),
  )
}

/** JSON safe inside <script>. */
const js = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e")
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)

/**
 * The runtime. Vanilla, no dependencies, builds DOM with textContent (never innerHTML of data),
 * so a row value cannot become markup. Formulas are evaluated by a tiny recursive-descent parser
 * over the same grammar validateSpec checked — never eval / Function.
 */
const RUNTIME = String.raw`(function(){
var spec=window.__IRIS_UI__||[],vars={},watchers=[];
function rows(n){return(window.iris&&iris.data)?iris.data.rows(n):[]}
function el(t,c,txt){var e=document.createElement(t);if(c)e.className=c;if(txt!=null)e.textContent=String(txt);return e}
function num(v){var n=typeof v==='number'?v:parseFloat(String(v).replace(/[$,%\s]/g,''));return isFinite(n)?n:null}
function fmt(v){if(typeof v!=='number')return v==null?'—':String(v);return Math.abs(v)>=1000?v.toLocaleString('en-US',{maximumFractionDigits:0}):(Math.round(v*100)/100).toLocaleString('en-US')}
function agg(list,field,a){if(a==='count')return list.length;var xs=list.map(function(r){return num(r[field])}).filter(function(x){return x!=null});if(!xs.length)return null;
 if(a==='sum')return xs.reduce(function(s,x){return s+x},0);if(a==='avg')return xs.reduce(function(s,x){return s+x},0)/xs.length;if(a==='min')return Math.min.apply(null,xs);return Math.max.apply(null,xs)}
function calc(src){var i=0,s=src.replace(/\s+/g,'');function peek(){return s[i]}
 function prim(){var c=peek();if(c==='('){i++;var v=add();i++;return v}if(c==='-'){i++;return -prim()}
  var m=/^\d+(\.\d+)?/.exec(s.slice(i));if(m){i+=m[0].length;return parseFloat(m[0])}
  m=/^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));if(m){i+=m[0].length;return +vars[m[0]]||0}throw new Error('bad formula')}
 function mul(){var v=prim();while(peek()==='*'||peek()==='/'){var o=s[i++],r=prim();v=o==='*'?v*r:v/r}return v}
 function add(){var v=mul();while(peek()==='+'||peek()==='-'){var o=s[i++],r=mul();v=o==='+'?v+r:v-r}return v}
 var v=add();if(i!==s.length)throw new Error('bad formula');return v}
var C={
Heading:function(p){return el('h'+Math.min(3,Math.max(1,p.level||2)),'ui-h',p.text)},
Text:function(p){return el('p','ui-t',p.text)},
Stat:function(p){var b=el('div','ui-stat'),l=el('div','ui-stat-l',p.label||''),v=el('div','ui-stat-v');b.appendChild(l);b.appendChild(v);
 function draw(){var x=p.formula?calc(String(p.formula)):(p.value&&typeof p.value==='object')?agg(rows(p.value.from),p.value.field,p.value.agg):p.value;v.textContent=(p.prefix||'')+fmt(x)+(p.suffix||'')}
 draw();if(p.formula)watchers.push(draw);return b},
Table:function(p){var w=el('div','ui-table'),data=rows(p.from).slice(),cols=(p.columns||Object.keys(data[0]||{}).slice(0,6)).map(function(c){return typeof c==='string'?{field:c,label:c}:{field:c.field,label:c.label||c.field}});
 cols.forEach(function(c){var seen=0,nums=0;data.forEach(function(r){var v=r[c.field];if(v==null||v==='')return;seen++;if(num(v)!=null&&!/[A-Za-z]/.test(String(v)))nums++});c.num=seen>0&&nums===seen});
 if(p.sort)data.sort(function(a,b){var x=num(a[p.sort]),y=num(b[p.sort]);if(x==null&&y==null)return String(a[p.sort]==null?'':a[p.sort]).localeCompare(String(b[p.sort]==null?'':b[p.sort]));if(x==null)return 1;if(y==null)return -1;return y-x});
 var q=null,all=false,cnt=el('div','ui-count'),more=el('button','ui-more');more.type='button';more.addEventListener('click',function(){all=true;draw()});
 if(p.search!==false){q=el('input','ui-search');q.type='search';q.placeholder='Search';w.appendChild(q)}
 var t=el('table'),th=el('thead'),hr=el('tr');cols.forEach(function(c){hr.appendChild(el('th',c.num?'n':null,c.label))});th.appendChild(hr);t.appendChild(th);var tb=el('tbody');t.appendChild(tb);w.appendChild(t);w.appendChild(cnt);w.appendChild(more);
 var lim=p.limit||25;
 function draw(){var s=q?q.value.toLowerCase():'',out=data.filter(function(r){return !s||cols.some(function(c){return String(r[c.field]==null?'':r[c.field]).toLowerCase().indexOf(s)!==-1})});
  var shown=all?out:out.slice(0,lim);tb.textContent='';shown.forEach(function(r){var tr=el('tr');cols.forEach(function(c){var v=r[c.field];var txt=v==null||v===''?'—':(typeof v==='object'?JSON.stringify(v):(c.num?fmt(num(v)):v));tr.appendChild(el('td',c.num?'n':null,txt))});tb.appendChild(tr)});
  cnt.textContent=out.length===data.length?data.length+' rows':out.length+' of '+data.length;
  more.hidden=shown.length>=out.length;more.textContent='Show all '+out.length}
 if(q)q.addEventListener('input',draw);draw();return w},
BarChart:function(p){var w=el('div','ui-bars'),m={},order=[];rows(p.from).forEach(function(r){var k=String(r[p.x]);if(!(k in m)){m[k]=[];order.push(k)}m[k].push(r)});
 var pts=order.map(function(k){return{k:k,v:agg(m[k],p.y,p.agg||'sum')||0}}),max=Math.max.apply(null,pts.map(function(x){return x.v}).concat([0]))||1;
 pts.slice(0,40).forEach(function(x){var r=el('div','ui-bar'),l=el('span','ui-bar-l',x.k),t=el('span','ui-bar-t'),f=el('i'),v=el('span','ui-bar-v',fmt(x.v));f.style.width=(100*x.v/max)+'%';t.appendChild(f);r.appendChild(l);r.appendChild(t);r.appendChild(v);w.appendChild(r)});return w},
Slider:function(p){var w=el('label','ui-slider'),l=el('span','ui-slider-l',p.label||p.name),i=el('input'),o=el('output','ui-slider-v');i.type='range';i.min=p.min!=null?p.min:0;i.max=p.max!=null?p.max:100;i.step=p.step!=null?p.step:1;i.value=p.value!=null?p.value:i.min;
 vars[p.name]=+i.value;o.textContent=fmt(+i.value);i.addEventListener('input',function(){vars[p.name]=+i.value;o.textContent=fmt(+i.value);watchers.forEach(function(f){f()})});w.appendChild(l);w.appendChild(i);w.appendChild(o);return w},
Row:function(p,ch){var r=el('div','ui-row');ch.forEach(function(c){r.appendChild(c)});return r},
Card:function(p,ch){var c=el('section','ui-card');if(p.title)c.appendChild(el('h3','ui-card-t',p.title));ch.forEach(function(x){c.appendChild(x)});return c},
Link:function(p){var a=el('a','ui-link',p.text||p.href);a.href=p.href;a.target='_blank';a.rel='noopener noreferrer';return a}
};
function build(n){var ch=(n.children||[]).map(build);var f=C[n.type];if(!f)return el('div','ui-err','unknown component '+n.type);try{return f(n.props||{},ch)}catch(e){return el('div','ui-err',n.type+': '+e.message)}}
function sliders(n){if(n.type==='Slider'&&n.props){vars[n.props.name]=+(n.props.value!=null?n.props.value:(n.props.min||0))}(n.children||[]).forEach(sliders)}
spec.forEach(sliders);var root=document.getElementById('ui');spec.forEach(function(n){root.appendChild(build(n))});
})()`

const STYLE = `
:root{--bg:#fbfaf8;--ink:#1d1c1a;--dim:#6f6b64;--rule:#e4e1db;--accent:#0f766e;--bar:#99d5cc;
--body:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#121413;--ink:#e9ecea;--dim:#8b938f;--rule:#262b29;--accent:#34d399;--bar:#1f5f50}}
*{box-sizing:border-box}body{margin:0;padding:14px;background:var(--bg);color:var(--ink);font:14px/1.45 var(--body)}
#ui{display:flex;flex-direction:column;gap:12px}
.ui-h{margin:0;font-weight:650;letter-spacing:-.01em}h1.ui-h{font-size:22px}h2.ui-h{font-size:18px}h3.ui-h{font-size:15px}
.ui-t{margin:0;color:var(--dim)}
.ui-row{display:flex;gap:10px;flex-wrap:wrap}.ui-row>*{flex:1 1 140px}
.ui-card{border:1px solid var(--rule);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:10px}.ui-card-t{margin:0;font-size:13px;color:var(--dim);font-weight:600}
.ui-stat{border:1px solid var(--rule);border-radius:10px;padding:10px 12px}.ui-stat-l{font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--dim)}
.ui-stat-v{font:600 22px/1.2 var(--mono);font-variant-numeric:tabular-nums;margin-top:2px}
.ui-search{width:100%;max-width:280px;padding:6px 9px;border:1px solid var(--rule);border-radius:7px;background:transparent;color:var(--ink);font:inherit;margin-bottom:6px}
.ui-table{overflow:auto}table{border-collapse:collapse;width:100%;font-size:13px}th{text-align:left;font-weight:600;color:var(--dim);font-size:11px;letter-spacing:.03em;text-transform:uppercase;border-bottom:1px solid var(--rule);padding:6px 8px}
td{padding:6px 8px;border-bottom:1px solid var(--rule)}td.n,th.n{font-family:var(--mono);font-variant-numeric:tabular-nums;text-align:right}
.ui-more{margin-top:6px;background:none;border:1px solid var(--rule);border-radius:7px;padding:4px 10px;color:var(--ink);font:12px var(--body);cursor:pointer}.ui-more[hidden]{display:none}
.ui-count{font:11px var(--mono);color:var(--dim);margin-top:6px}
.ui-bars{display:flex;flex-direction:column;gap:5px}.ui-bar{display:grid;grid-template-columns:minmax(60px,30%) 1fr auto;gap:8px;align-items:center;font-size:12px}
.ui-bar-l{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dim)}.ui-bar-t{height:10px;background:var(--rule);border-radius:3px;overflow:hidden}.ui-bar-t i{display:block;height:100%;background:var(--bar)}
.ui-bar-v{font-family:var(--mono);font-variant-numeric:tabular-nums}
.ui-slider{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center}.ui-slider-l{color:var(--dim);font-size:13px}.ui-slider input{accent-color:var(--accent)}
.ui-slider-v{font:600 14px var(--mono);font-variant-numeric:tabular-nums;min-width:3ch;text-align:right}
.ui-link{color:var(--accent)}.ui-err{color:#b42318;font:12px var(--mono)}
`

/** A complete html document for the spec. Bindings are injected by the caller (injectBindings). */
export function specDocument(nodes: UiNode[], title: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${STYLE}</style></head>` +
    `<body><div id="ui"></div><script>window.__IRIS_UI__=${js(nodes)}</script><script>${RUNTIME}</script></body></html>`
  )
}
