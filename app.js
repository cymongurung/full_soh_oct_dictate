const STORAGE_KEY = "theDealInventoryV1";
const META_KEY = "theDealInventoryMetaV1";

let inventory = [];
let meta = {};
let scanner = null;
let scannerRunning = false;
let pendingUpload = null;
let activeVideoTrack = null;
let activeZoom = null;

// Voice Dictation state
let isVoiceEnabled = true;

const $ = id => document.getElementById(id);

function clean(v){ return (v ?? "").toString().trim(); }
function normalize(v){ return clean(v).replace(/^'/,"").replace(/\s+/g,""); }

function money(v){
  const n = Number(String(v).replace(/,/g,""));
  return Number.isFinite(n) ? "AED " + n.toLocaleString("en-AE",{minimumFractionDigits:2,maximumFractionDigits:2}) : clean(v) || "—";
}

function qty(v){
  const n = Number(String(v).replace(/,/g,""));
  return Number.isFinite(n) ? n.toLocaleString("en-AE") : clean(v) || "0";
}

const DB_NAME = "TheDealStockScannerDB";
const DB_VERSION = 1;
const STORE_NAME = "inventory";

function openDB(){
  return new Promise((resolve,reject)=>{
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if(!db.objectStoreNames.contains(STORE_NAME)){
        db.createObjectStore(STORE_NAME, {keyPath:"key"});
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function save(){
  const db = await openDB();
  await new Promise((resolve,reject)=>{
    const tx = db.transaction(STORE_NAME,"readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.put({key:"inventory", value:inventory});
    store.put({key:"meta", value:meta});
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function loadSaved(){
  try{
    const db = await openDB();
    const result = await new Promise((resolve,reject)=>{
      const tx = db.transaction(STORE_NAME,"readonly");
      const store = tx.objectStore(STORE_NAME);
      const req1 = store.get("inventory");
      const req2 = store.get("meta");
      tx.oncomplete = () => resolve({
        inventory:req1.result?.value || [],
        meta:req2.result?.value || {}
      });
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    if(Array.isArray(result.inventory) && result.inventory.length){
      inventory=result.inventory;
      meta=result.meta;
      return true;
    }
  }catch(e){
    console.error("IndexedDB load error:",e);
  }
  return false;
}

function updateHeader(){
  $("topDate").textContent = meta.stockDate
    ? `Current data: ${meta.stockDate} • ${inventory.length.toLocaleString()} rows`
    : "No data loaded";
  renderStatus();
}

function parseCSVLine(line){
  const out = [];
  let field = "";
  let quoted = false;

  for(let i=0;i<line.length;i++){
    const ch = line[i];
    if(ch === '"'){
      if(quoted && line[i+1] === '"'){
        field += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if(ch === "," && !quoted){
      out.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

function parseCSV(text){
  const rows = [];
  let line = "";
  let quoted = false;

  for(let i=0;i<text.length;i++){
    const ch = text[i];
    if(ch === '"'){
      if(quoted && text[i+1] === '"'){
        line += '""';
        i++;
      } else {
        quoted = !quoted;
        line += ch;
      }
    } else if((ch === "\n" || ch === "\r") && !quoted){
      if(line.length || (rows.length && rows[rows.length-1].length)){
        rows.push(parseCSVLine(line));
      }
      line = "";
      if(ch === "\r" && text[i+1] === "\n") i++;
    } else {
      line += ch;
    }
  }
  if(line.length) rows.push(parseCSVLine(line));
  return rows;
}

function parseStoreCSV(text, filename){
  const rows = parseCSV(text);
  const headerIndex = rows.findIndex(r =>
    r.some(c => clean(c).toLowerCase() === "product id")
  );
  if(headerIndex < 0) throw new Error("Could not find the Product ID header in this CSV.");

  const headers = rows[headerIndex].map(clean);
  const body = rows.slice(headerIndex+1).filter(r => r.some(clean));
  const idx = {};
  headers.forEach((h,i)=>idx[h]=i);

  const get = (row, name) => row[idx[name]] ?? "";
  const data = body.map(r => ({
    stockDate: clean(get(r,"Stock Date")),
    productId: normalize(get(r,"Product ID")),
    description: clean(get(r,"Product Description w/o vpn")),
    zone: clean(get(r,"Zone Description")),
    department: clean(get(r,"Department")),
    brand: clean(get(r,"Brand")),
    barcode: normalize(get(r,"Barcode")),
    vpn: clean(get(r,"VPN")),
    retailPrice: clean(get(r,"Retail Selling Price Local")),
    consignment: clean(get(r,"Is Consignment? (Yes / No)")),
    season: clean(get(r,"Season")),
    wac: clean(get(r,"WAC in USD")),
    sold: clean(get(r,"Total Quantity Sold")),
    closingSoh: clean(get(r,"Daily closing SOH quantity")),
    closingValue: clean(get(r,"Daily closing SOH Local Retail Value"))
  })).filter(x => x.productId || x.barcode);

  if(!data.length) throw new Error("No product records were found.");
  const stockDate = data.find(x=>x.stockDate)?.stockDate || "";
  return {data, stockDate, filename, headers};
}

async function loadInitial(){
  if(await loadSaved()){ updateHeader(); return; }
  fetch("data/current.csv")
    .then(r => { if(!r.ok) throw new Error("Initial CSV not found"); return r.text(); })
    .then(async text => {
      const result = parseStoreCSV(text,"data/current.csv");
      inventory = result.data;
      meta = {stockDate:result.stockDate, filename:result.filename, uploadedAt:new Date().toISOString()};
      await save();
      updateHeader();
      toast("Today's inventory loaded");
    })
    .catch(err=>{ console.error(err); updateHeader(); });
}

function findProduct(term){
  const q = normalize(term);
  if(!q) return [];
  return inventory.filter(x => normalize(x.barcode) === q || normalize(x.productId) === q);
}

// Voice Dictation Helper Function
function speakPrice(priceVal) {
  if (!isVoiceEnabled || !('speechSynthesis' in window)) return;
  
  // Cancel any ongoing speech
  window.speechSynthesis.cancel();

  const num = Number(String(priceVal).replace(/,/g, ""));
  let textToSpeak = "";
  
  if (Number.isFinite(num)) {
    textToSpeak = `Price is ${Math.round(num)} dirhams`;
  } else {
    textToSpeak = "Price not available";
  }

  const utterance = new SpeechSynthesisUtterance(textToSpeak);
  utterance.rate = 0.95;
  utterance.pitch = 1.0;
  window.speechSynthesis.speak(utterance);
}

function showProduct(product){
  const related = inventory.filter(x => x.vpn && x.vpn === product.vpn);
  
  // Determine consignment / supplier text
  const consignmentVal = (product.consignment || "").toLowerCase();
  const isSupplier = (consignmentVal === "yes" || consignmentVal === "y") ? "Yes (Consignment)" : "No";

  // Trigger voice dictation
  speakPrice(product.retailPrice);

  $("resultArea").innerHTML = `
    <div class="result-card">
      <div class="result-head">
        <h2>${esc(product.description || "Product found")}</h2>
        <p>${esc(product.brand || "")} ${product.department ? "• "+esc(product.department):""}</p>
      </div>
      <div class="metrics">
        <div class="metric"><label>Retail Price</label><strong>${money(product.retailPrice)}</strong></div>
        <div class="metric"><label>Daily Closing SOH</label><strong>${qty(product.closingSoh)}</strong></div>
        <div class="metric"><label>VPN</label><strong>${esc(product.vpn || "—")}</strong></div>
      </div>
      <div class="details">
        <div class="detail-row"><span>Product ID</span><strong>${esc(product.productId)}</strong></div>
        <div class="detail-row"><span>Barcode</span><strong>${esc(product.barcode)}</strong></div>
        <div class="detail-row"><span>Supplier / Consignment Item</span><strong>${esc(isSupplier)}</strong></div>
        <div class="detail-row"><span>Description</span><strong>${esc(product.description)}</strong></div>
        <div class="detail-row"><span>Brand</span><strong>${esc(product.brand)}</strong></div>
        <div class="detail-row"><span>Department</span><strong>${esc(product.department)}</strong></div>
      </div>
      <div class="actions">
        <button class="primary" id="relatedYes" ${related.length <= 1 ? "disabled":""}>YES — Related Items (${Math.max(related.length-1,0)})</button>
        <button class="secondary" id="clearResult">NO / Next Scan</button>
      </div>
      <div class="related" id="relatedArea"></div>
    </div>`;
  $("relatedYes").addEventListener("click",()=>showRelated(product));
  $("clearResult").addEventListener("click",()=>clearResult());
}

function showRelated(product){
  const related = inventory.filter(x => x.vpn && x.vpn === product.vpn);
  const rows = related.map(x => `
    <tr>
      <td>${esc(x.productId)}</td>
      <td>${esc(x.barcode)}</td>
      <td>${esc(x.description)}</td>
      <td>${money(x.retailPrice)}</td>
      <td class="soh ${Number(x.closingSoh)===0?'zero':'positive'}">${qty(x.closingSoh)}</td>
    </tr>`).join("");
  $("relatedArea").innerHTML = `
    <h3>Related Items — Same VPN</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>Product ID</th><th>Barcode</th><th>Product Description</th><th>Retail Price</th><th>Daily Closing SOH</th></tr></thead>
      <tbody>${rows || "<tr><td colspan='5'>No related items found.</td></tr>"}</tbody>
    </table></div>`;
}

function search(){
  const term = $("searchInput").value;
  const matches = findProduct(term);
  if(matches.length === 1){ showProduct(matches[0]); return; }
  if(matches.length > 1){
    $("resultArea").innerHTML = `<div class="result-card"><div class="result-head"><h2>Multiple matches</h2><p>Please select a product.</p></div><div class="details">${
      matches.map((x,i)=>`<button class="secondary select-match" data-i="${i}" style="display:block;width:100%;margin:8px 0;text-align:left">
        ${esc(x.productId)} • ${esc(x.barcode)} • ${esc(x.description)} • SOH ${qty(x.closingSoh)}
      </button>`).join("")
    }</div></div>`;
    document.querySelectorAll(".select-match").forEach(b=>b.addEventListener("click",()=>showProduct(matches[Number(b.dataset.i)])));
    return;
  }
  $("resultArea").innerHTML = `<div class="result-card"><div class="result-head"><h2>Not found</h2><p>No matching Barcode or Product ID was found in the current inventory.</p></div></div>`;
}

function clearResult(){ $("resultArea").innerHTML=""; $("searchInput").value=""; $("searchInput").focus(); }

function esc(v){
  return String(v ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
}

function updateZoomLabel(text){
  const el=document.getElementById("zoomStatus");
  if(el) el.textContent=text;
}

function setScannerZoom(){
  const video=document.querySelector("#reader video");
  if(!video || !video.srcObject) return;
  const tracks=video.srcObject.getVideoTracks();
  if(!tracks.length) return;
  const track=tracks[0];
  activeVideoTrack=track;
  const capabilities=track.getCapabilities ? track.getCapabilities() : {};
  if(!capabilities.zoom){ activeZoom=null; updateZoomLabel("Zoom: not supported by this camera/browser"); return; }
  const min=Number(capabilities.zoom.min ?? 1), max=Number(capabilities.zoom.max ?? min), step=Number(capabilities.zoom.step ?? 0.1);
  let target=max >= 2 ? 2 : max;
  target=Math.max(min,Math.min(max,target));
  if(step>0){ target=min+Math.round((target-min)/step)*step; target=Math.max(min,Math.min(max,target)); }
  track.applyConstraints({advanced:[{zoom:target}]})
    .then(()=>{ activeZoom=target; updateZoomLabel(`Zoom: ${Number(target).toFixed(target%1?1:0)}×`); })
    .catch(()=>updateZoomLabel("Zoom: camera default"));
}

function openCamera(){
  if(scannerRunning) return;
  $("reader").classList.remove("hidden");
  $("openScanner").textContent="✕ Close Scanner";
  updateZoomLabel("Opening camera… Default zoom: 2×");
  scanner=new Html5Qrcode("reader");
  scanner.start(
    {facingMode:"environment"},
    {fps:10,qrbox:{width:280,height:140}},
    code=>{ stopCamera(); $("searchInput").value=code; search(); toast("Barcode scanned"); },
    ()=>{}
  ).then(()=>{
    scannerRunning=true;
    setScannerZoom();
    setTimeout(setScannerZoom,250);
    setTimeout(setScannerZoom,800);
  }).catch(err=>{
    $("reader").classList.add("hidden");
    $("openScanner").textContent="📷 Scan Barcode";
    updateZoomLabel("Camera unavailable");
    toast("Camera could not be opened. Check browser camera permission.");
    console.error(err);
  });
}

function stopCamera(){
  if(scanner && scannerRunning){
    scanner.stop().catch(()=>{}).finally(()=>{ scannerRunning=false; activeVideoTrack=null; activeZoom=null; });
  } else { activeVideoTrack=null; activeZoom=null; }
  $("reader").classList.add("hidden");
  $("openScanner").textContent="📷 Scan Barcode";
  updateZoomLabel("Camera closed");
}

function renderStatus(){
  const totalSoh = inventory.reduce((s,x)=>s+(Number(String(x.closingSoh).replace(/,/g,""))||0),0);
  const totalValue = inventory.reduce((s,x)=>s+(Number(String(x.closingValue).replace(/,/g,""))||0),0);
  $("statusGrid").innerHTML = `
    <div class="status-item"><small>Status</small><strong>● Current</strong></div>
    <div class="status-item"><small>Stock Date</small><strong>${esc(meta.stockDate||"—")}</strong></div>
    <div class="status-item"><small>Rows / SKUs</small><strong>${inventory.length.toLocaleString()}</strong></div>
    <div class="status-item"><small>Total Closing SOH</small><strong>${totalSoh.toLocaleString()}</strong></div>
    <div class="status-item"><small>Total Retail Stock Value</small><strong>${money(totalValue)}</strong></div>
    <div class="status-item"><small>File</small><strong style="font-size:13px;word-break:break-word">${esc(meta.filename||"—")}</strong></div>`;
}

function toast(msg){
  const t=$("toast"); t.textContent=msg; t.classList.add("show");
  clearTimeout(window.__toast); window.__toast=setTimeout(()=>t.classList.remove("show"),2500);
}

function showPage(page){
  document.querySelectorAll(".page").forEach(p=>p.classList.remove("active"));
  document.querySelectorAll(".nav").forEach(n=>n.classList.remove("active"));
  $(`${page}Page`).classList.add("active");
  document.querySelector(`.nav[data-page="${page}"]`).classList.add("active");
  $("pageTitle").textContent = page==="scanner" ? "Stock Scanner" : page==="upload" ? "Upload Data" : "Data Status";
  if(page==="status") renderStatus();
  $("sidebar").classList.remove("open"); $("backdrop").classList.remove("show");
}

// Voice Toggle Handler
$("voiceToggle").addEventListener("click", () => {
  isVoiceEnabled = !isVoiceEnabled;
  const btn = $("voiceToggle");
  if (isVoiceEnabled) {
    btn.classList.add("active");
    btn.textContent = "🔊 Voice: ON";
    toast("Voice dictation enabled");
  } else {
    btn.classList.remove("active");
    btn.textContent = "🔇 Voice: OFF";
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    toast("Voice dictation muted");
  }
});

$("searchBtn").addEventListener("click",search);
$("searchInput").addEventListener("keydown",e=>{if(e.key==="Enter")search();});
$("openScanner").addEventListener("click",()=>scannerRunning?stopCamera():openCamera());
$("chooseFile").addEventListener("click",()=>$("csvFile").click());
$("csvFile").addEventListener("change",e=>e.target.files[0]&&handleUpload(e.target.files[0]));
$("confirmReplace").addEventListener("click",confirmUpload);
$("cancelReplace").addEventListener("click",cancelUpload);

$("dropzone").addEventListener("dragover",e=>{e.preventDefault();$("dropzone").style.borderColor="#111827";});
$("dropzone").addEventListener("dragleave",()=>$("dropzone").style.borderColor="");
$("dropzone").addEventListener("drop",e=>{e.preventDefault();$("dropzone").style.borderColor="";const f=e.dataTransfer.files[0];if(f)handleUpload(f);});
document.querySelectorAll(".nav").forEach(n=>n.addEventListener("click",()=>showPage(n.dataset.page)));
$("menuBtn").addEventListener("click",()=>{$("sidebar").classList.add("open");$("backdrop").classList.add("show");});
$("backdrop").addEventListener("click",()=>{$("sidebar").classList.remove("open");$("backdrop").classList.remove("show");});

function handleUpload(file){
  if(!file.name.toLowerCase().endsWith(".csv")){
    return uploadMsg("Please select a CSV file.","error");
  }
  const reader = new FileReader();
  reader.onload = e => {
    try{
      const result = parseStoreCSV(e.target.result,file.name);
      pendingUpload = result;
      $("currentUploadInfo").textContent =
        meta.stockDate ? `${meta.stockDate} • ${inventory.length.toLocaleString()} rows` : "No current inventory";
      let newInfo = `${result.stockDate || "Date not detected"} • ${result.data.length.toLocaleString()} rows`;
      if(meta.stockDate && result.stockDate && result.stockDate < meta.stockDate) newInfo += " ⚠ Older date";
      $("newUploadInfo").textContent = newInfo;
      $("newFileInfo").textContent = file.name;
      $("replaceModal").classList.remove("hidden");
    }catch(err){
      uploadMsg(err.message || "Could not process the CSV.","error");
    }
  };
  reader.onerror = () => uploadMsg("The browser could not read this file.","error");
  reader.readAsText(file);
}

async function confirmUpload(){
  if(!pendingUpload) return;
  const result = pendingUpload;
  inventory = result.data;
  meta = {stockDate:result.stockDate,filename:result.filename,uploadedAt:new Date().toISOString()};
  try{
    await save();
    updateHeader();
    $("replaceModal").classList.add("hidden");
    pendingUpload = null;
    $("csvFile").value = "";
    uploadMsg(`✓ Inventory replaced successfully. ${inventory.length.toLocaleString()} product rows loaded for ${result.stockDate || "the supplied date"}.`, "success");
    toast("Inventory updated");
  }catch(err){
    uploadMsg("The file was read, but the browser could not save the inventory. Please use a normal HTTPS website (such as GitHub Pages) and try again.", "error");
    console.error(err);
  }
}

function cancelUpload(){
  pendingUpload = null;
  $("replaceModal").classList.add("hidden");
  $("csvFile").value = "";
}

function uploadMsg(text,type){
  const m=$("uploadMessage");m.textContent=text;m.className="message "+(type==="error"?"error":"");m.classList.remove("hidden");
}

loadInitial();
