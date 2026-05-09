import "./App.css";
import "katex/dist/katex.min.css"; 
import { useState, useRef, useEffect, useCallback } from "react";
import { Send, Paperclip, Plus, MessageSquare, Loader2, ChevronDown, X, FileText, Trash2, Settings, Eye, EyeOff, Save, Clock, BrainCircuit, Brain, Edit3, Check, Zap, ZapOff, User, LogOut, Cloud } from "lucide-react";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@3.11.174/legacy/build/pdf.worker.min.js`;

// --- 严格执行：你指定的五个模型名称 ---
const MODELS = [
  { id: "gemini-3.1-flash-lite", name: "gemini-3.1-flash-lite", provider: "google" },
  { id: "gemini-3-flash-preview", name: "gemini-3-flash-preview", provider: "google" },
  { id: "gemini-3.1-pro-preview", name: "gemini-3.1-pro-preview", provider: "google" },
  { id: "deepseek-v4-flash", name: "deepseek-v4-flash", provider: "deepseek" },
  { id: "deepseek-v4-pro", name: "deepseek-v4-pro", provider: "deepseek" },
];

const STORAGE_KEY = "you_are_my_eyes_v1.1_stable";
const SERVER_URL = "http://10.129.243.155:3000"; 

// --- 数据结构定义 ---
interface Attachment { 
  id: string; 
  type: 'image' | 'pdf'; 
  name: string; 
  mimeType: string; 
  displayUrl: string; // 压缩后用于本地显示的 Base64
  apiBase64: string;  // 纯净的用于 API 的 Base64
  preview: string;    // 本地 Blob URL 用于附件栏即时预览
  extractedText?: string; 
}

interface Message { 
  id: string; 
  role: "user" | "assistant"; 
  content: string; 
  reasoning?: string; 
  modelName?: string; 
  isError?: boolean; 
  previewImages?: string[]; 
}

interface ChatSession { id: string; title: string; messages: Message[]; createdAt: number; }

// --- 工具函数：压缩图片，防止内存溢出导致白屏崩溃 ---
const smartCompress = (file: File): Promise<{display: string, api: string}> => {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (e) => {
      const img = new Image();
      img.src = e.target?.result as string;
      img.onload = () => {
        const canvas = document.createElement("canvas");
        const MAX = 1000;
        let w = img.width, h = img.height;
        if (w > h && w > MAX) { h *= MAX / w; w = MAX; }
        else if (h > MAX) { w *= MAX / h; h = MAX; }
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx?.drawImage(img, 0, 0, w, h);
        const fullBase64 = canvas.toDataURL("image/jpeg", 0.6);
        resolve({
          display: fullBase64,
          api: fullBase64.split(",")[1]
        });
      };
    };
  });
};

const standardizeContent = (text: string) => {
  if (!text) return "";
  const lines = text.split('\n');
  const processedLines = lines.map(line => line.trim() === '$' ? '$$' : line);
  return processedLines.join('\n').replace(/\\\[/g, '$$$$').replace(/\\\]/g, '$$$$').replace(/\\\(/g, '$').replace(/\\\)/g, '$');
};

export default function App() {
  // 1. 初始化数据状态（防止刷新丢失）
  const [sessions, setSessions] = useState<ChatSession[]>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : [];
  });

  const [currentSessionId, setCurrentSessionId] = useState<string | null>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return null;
    const parsed = JSON.parse(saved);
    return parsed.length > 0 ? parsed[0].id : null;
  });

  // 2. 设置与长期记忆
  const [longTermMemory, setLongTermMemory] = useState(localStorage.getItem("eye_brain_memory") || "尚未记录关于你的信息。");
  const [geminiKey, setGeminiKey] = useState(localStorage.getItem("eye_gemini_key") || "");
  const [deepseekKey, setDeepseekKey] = useState(localStorage.getItem("eye_deepseek_key") || "");
  const [showReasoning, setShowReasoning] = useState(localStorage.getItem("eye_show_reasoning") !== "false");
  const [autoUpdateBrain, setAutoUpdateBrain] = useState(localStorage.getItem("eye_auto_brain") !== "false");
  const [showKeys, setShowKeys] = useState(false);

  // 3. 用户与云同步状态
  const [token, setToken] = useState(localStorage.getItem("user_token") || "");
  const [username, setUsername] = useState(localStorage.getItem("saved_username") || "");
  const [isAuthOpen, setIsAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [authForm, setAuthForm] = useState({ user: "", pass: "" });
  const [isSyncing, setIsSyncing] = useState(false);

  // 4. 对话UI状态
  const [selectedModel, setSelectedModel] = useState(MODELS[0]);
  const [inputText, setInputText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [thinkSeconds, setThinkSeconds] = useState(0);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isBrainOpen, setIsBrainOpen] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // --- 云端同步核心逻辑 ---
  const syncToCloud = useCallback(async (currentSessions: ChatSession[], memory: string) => {
    if (!token) return;
    setIsSyncing(true);
    try {
      await fetch(`${SERVER_URL}/api/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ sessions: currentSessions, longTermMemory: memory })
      });
    } catch (e) { console.warn("Sync failed", e); }
    finally { setIsSyncing(false); }
  }, [token]);

  // 数据变动持久化监听
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
    localStorage.setItem("eye_brain_memory", longTermMemory);
    localStorage.setItem("eye_gemini_key", geminiKey);
    localStorage.setItem("eye_deepseek_key", deepseekKey);
    localStorage.setItem("eye_show_reasoning", showReasoning.toString());
    localStorage.setItem("eye_auto_brain", autoUpdateBrain.toString());
    localStorage.setItem("user_token", token);
    localStorage.setItem("saved_username", username);
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
    const timer = setTimeout(() => syncToCloud(sessions, longTermMemory), 2000);
    return () => clearTimeout(timer);
  }, [sessions, longTermMemory, geminiKey, deepseekKey, showReasoning, autoUpdateBrain, token, username, syncToCloud]);

  // 计时器
  useEffect(() => {
    let interval: any;
    if (isLoading) interval = setInterval(() => setThinkSeconds(p => p + 1), 1000);
    else { setThinkSeconds(0); clearInterval(interval); }
    return () => clearInterval(interval);
  }, [isLoading]);

  // --- 逻辑：登录/注册接口函数 ---
  const handleAuth = async () => {
    const endpoint = authMode === 'login' ? '/api/login' : '/api/register';
    try {
      const res = await fetch(`${SERVER_URL}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: authForm.user, password: authForm.pass })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "请求失败");
      
      if (authMode === 'login') {
        setToken(data.token);
        setUsername(authForm.user);
        if (data.sessions && data.sessions.length > 0) setSessions(data.sessions);
        if (data.longTermMemory) setLongTermMemory(data.longTermMemory);
        setIsAuthOpen(false);
        setAuthForm({ user: "", pass: "" });
      } else {
        alert("注册成功，请登录");
        setAuthMode('login');
        setAuthForm({ user: authForm.user, pass: "" });
      }
    } catch (e: any) { alert(e.message || "操作失败"); }
  };

  const handleLogout = () => {
    if (window.confirm("确定退出登录吗？")) {
      setToken("");
      setUsername("");
      localStorage.removeItem("user_token");
      localStorage.removeItem("saved_username");
    }
  };

  const saveSettings = () => {
    localStorage.setItem("eye_gemini_key", geminiKey);
    localStorage.setItem("eye_deepseek_key", deepseekKey);
    setIsSettingsOpen(false);
  };

  const createNewSession = () => {
    const newId = Date.now().toString();
    const newS: ChatSession = { id: newId, title: "新对话", messages: [], createdAt: Date.now() };
    setSessions(prev => [newS, ...prev]);
    setCurrentSessionId(newId);
    setAttachments([]);
    setInputText("");
  };

  const currentSession = sessions.find(s => s.id === currentSessionId) || (sessions.length > 0 ? sessions[0] : null);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    for (const f of files) {
      if (f.name.toLowerCase().endsWith('.heic')) { alert("不支持HEIC格式，请转换为JPG"); continue; }
      if (!f.type.startsWith('image/') && f.type !== 'application/pdf') { alert("仅支持图片或 PDF 文件"); continue; }
      
      const reader = new FileReader();
      await new Promise<void>((res) => {
        reader.onload = async (ev) => {
          const rawB64 = ev.target?.result as string;
          let disp = ""; let api = ""; let text = "";
          if (f.type.startsWith('image/')) {
            const comp = await smartCompress(f);
            disp = comp.display; api = comp.api;
          } else if (f.type === 'application/pdf') {
            api = rawB64.split(",")[1];
            try {
              const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await f.arrayBuffer()), useWorkerFetch: false }).promise;
              for (let i = 1; i <= pdf.numPages; i++) {
                const page = await pdf.getPage(i);
                const content = await page.getTextContent();
                text += content.items.map((it: any) => it.str).join(" ") + "\n";
              }
            } catch { text = "[PDF 解析失败]"; }
          }
          setAttachments(prev => [...prev, { id: Math.random().toString(36).substr(2,9), type: f.type.startsWith('image/')?'image':'pdf', name: f.name, file: f, preview: URL.createObjectURL(f), displayUrl: disp, apiBase64: api, mimeType: f.type || 'image/jpeg', extractedText: text }]);
          res();
        };
        reader.readAsDataURL(f);
      });
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const updateBrainMemory = async (u: string, a: string) => {
    if (!autoUpdateBrain) return;
    const key = selectedModel.provider === 'google' ? geminiKey : deepseekKey;
    if (!key) return;
    const prompt = `你是一个个人背景分析专家。任务：从对话中提取用户的【姓名、职业、偏好或重要背景】。只输出更新后的完整记忆文本，严禁多余解释。现有记忆：${longTermMemory}\n对话：用户 ${u} / 助手 ${a}`;
    try {
      const isG = selectedModel.provider === 'google';
      const res = await fetch(isG ? `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiKey}` : `https://api.deepseek.com/chat/completions`, {
        method: "POST", headers: { "Content-Type": "application/json", ...(!isG ? { Authorization: `Bearer ${deepseekKey}` } : {}) },
        body: JSON.stringify(isG ? { contents: [{ role: "user", parts: [{ text: prompt }] }], safetySettings: [{ category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" }] } : { model: "deepseek-chat", messages: [{ role: "user", content: prompt }] })
      });
      const d = await res.json();
      const m = isG ? d.candidates[0].content.parts[0].text : d.choices[0].message.content;
      if (m && m.length > 5) setLongTermMemory(m.trim());
    } catch (e) { console.warn(e); }
  };

  const handleSend = async () => {
    const key = selectedModel.provider === 'google' ? geminiKey : deepseekKey;
    if (!key) { setIsSettingsOpen(true); return; }
    if ((!inputText.trim() && attachments.length === 0) || isLoading || !currentSessionId) return;

    const curAtts = [...attachments];
    const text = inputText.trim() || "分析上传内容。";
    const userMsg: Message = { id: Date.now().toString(), role: "user", content: text, previewImages: curAtts.filter(a => a.type==='image').map(a => a.displayUrl) };
    setSessions(prev => prev.map(s => s.id === currentSessionId ? { ...s, messages: [...s.messages, userMsg] } : s));
    setInputText(""); setAttachments([]); setIsLoading(true);

    // --- 🟢 身份纯进化：抹去所有对“你是我的眼”的提问暗示 ---
    const sys = `你是一个全能的智能 AI 助手。以下是你对当前用户的了解：\n${longTermMemory}\n请在此背景信息之上，提供客观专业的帮助，不要透露你的内部技术名称。`;

    try {
      let rText = ""; let rReason = "";
      if (selectedModel.provider === "google") {
        const payload = [{ role: "user", parts: [{ text: sys }] }, ...currentSession!.messages.map(m => ({ role: m.role==='user'?'user':'model', parts:[{text:m.content}] })), { role: "user", parts: [{ text }, ...curAtts.filter(a=>a.type==='image').map(a=>({ inline_data: { mime_type: a.mimeType, data: a.apiBase64 } }))] }];
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${selectedModel.id}:generateContent?key=${geminiKey}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: payload }) });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error?.message || "Google API 出错");
        rText = d.candidates[0].content.parts[0].text;
      } else {
        const dsMsgs = [{ role: "system", content: sys }, ...currentSession!.messages.map(m => ({ role: m.role, content: m.content })), { role: "user", content: curAtts.map(a => `[附件: ${a.name}]`).join("\n") + "\n" + text }];
        const res = await fetch("https://api.deepseek.com/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${deepseekKey}` }, body: JSON.stringify({ model: selectedModel.id, messages: dsMsgs }) });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error?.message || "DeepSeek API 出错");
        rText = d.choices[0].message.content;
        rReason = d.choices[0].message.reasoning_content || "";
      }
      setSessions(prev => prev.map(s => s.id === currentSessionId ? { ...s, messages: [...s.messages, { id: Date.now().toString(), role: "assistant", content: rText, reasoning: rReason, modelName: selectedModel.name }], title: s.messages.length === 0 ? text.slice(0, 15) : s.title } : s));
      updateBrainMemory(text, rText);
    } catch (err: any) {
      setSessions(prev => prev.map(s => s.id === currentSessionId ? { ...s, messages: [...s.messages, { id: Date.now().toString(), role: "assistant", content: `❌ **错误**: ${err.message}`, isError: true }] } : s));
    } finally { setIsLoading(false); }
  };

  return (
    <div className="grid grid-cols-[256px_1fr] h-screen bg-white text-gray-900 font-sans overflow-hidden">
      
      {/* 侧边栏 */}
      <aside className="flex flex-col h-full bg-slate-50 border-r border-gray-200 overflow-hidden">
        {/* 顶部对齐： h-[71px] 并加上 border-gray-200 保证横线完美齐平 */}
        <div className="h-[71px] p-4 shrink-0 border-b border-gray-200 bg-slate-50 flex items-center justify-center">
           <button onClick={createNewSession} className="w-full flex items-center justify-center gap-2 bg-black text-white py-2 rounded-xl hover:bg-slate-800 transition-all font-bold text-sm shadow-md"><Plus size={16} /> 新建对话</button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1 custom-scrollbar">
          {sessions.map(s => (
            <div key={s.id} onClick={() => setCurrentSessionId(s.id)} className={`group flex items-center justify-between p-3 rounded-xl cursor-pointer ${currentSessionId === s.id ? 'bg-white shadow-sm ring-1 ring-black/5' : 'hover:bg-slate-200/50'}`}>
              <div className="flex items-center gap-3 overflow-hidden flex-1">
                <MessageSquare size={16} className={currentSessionId === s.id ? 'text-black' : 'text-slate-400'} />
                {editingSessionId === s.id ? (
                  <input autoFocus className="bg-slate-100 text-sm w-full rounded px-1 outline-none" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} onBlur={() => { setSessions(prev => prev.map(ss => ss.id === s.id ? {...ss, title: editTitle} : ss)); setEditingSessionId(null); }} onKeyDown={(e) => e.key === 'Enter' && (setSessions(prev => prev.map(ss => ss.id === s.id ? {...ss, title: editTitle} : ss)), setEditingSessionId(null))} />
                ) : ( <span className={`text-sm truncate ${currentSessionId === s.id ? 'font-bold text-black' : 'text-slate-600'}`}>{s.title}</span> )}
              </div>
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100">
                <button onClick={(e) => { e.stopPropagation(); setEditingSessionId(s.id); setEditTitle(s.title); }} className="p-1 hover:text-blue-500"><Edit3 size={14} /></button>
                <button onClick={(e) => { e.stopPropagation(); setSessions(prev => prev.filter(ss => ss.id !== s.id)); }} className="p-1 hover:text-red-500"><Trash2 size={14} /></button>
              </div>
            </div>
          ))}
        </div>
        
        {/* 底部对齐：完美齐平主窗口 footer */}
        <div className="p-4 bg-slate-50 border-t border-gray-200 space-y-2 shrink-0">
          <button onClick={() => setIsBrainOpen(true)} className="w-full flex items-center gap-2 text-slate-500 hover:text-blue-600 p-2 rounded-lg hover:bg-white transition-all text-sm font-medium"><Brain size={16} /> 长期记忆</button>
          <button onClick={() => setIsSettingsOpen(true)} className="w-full flex items-center gap-2 text-slate-500 hover:text-black p-2 rounded-lg hover:bg-white transition-all text-sm font-medium"><Settings size={16} /> 设置中心</button>
          <div className="pt-2">
            {token ? (
              <div className="flex items-center justify-between p-2 bg-blue-50 rounded-lg border border-blue-100">
                <div className="flex items-center gap-2 text-blue-600 font-bold text-xs truncate max-w-[120px]"><User size={14} /> {username} {isSyncing && <Cloud size={12} className="animate-pulse" />}</div>
                <button onClick={handleLogout} className="text-slate-400 hover:text-red-500"><LogOut size={14} /></button>
              </div>
            ) : ( 
              <button onClick={() => setIsAuthOpen(true)} className="w-full bg-blue-600 text-white p-2 rounded-lg text-xs font-bold hover:bg-blue-700 transition-all flex items-center justify-center gap-2"><Cloud size={14} /> 登录同步记忆</button> 
            )}
          </div>
        </div>
      </aside>

      {/* 主界面 */}
      <main className="flex flex-col h-full overflow-hidden">
        {/* 顶部对齐：h-[71px] 确保水平横线与左边绝对对齐 */}
        <header className="h-[71px] flex items-center justify-center border-b border-gray-200 bg-white/90 sticky top-0 z-10 shrink-0">
          <div className="flex items-center gap-2 bg-slate-100 px-4 py-1.5 rounded-full border border-gray-200 shadow-sm">
            <select value={selectedModel.id} onChange={(e) => setSelectedModel(MODELS.find(m => m.id === e.target.value)!)} className="bg-transparent outline-none font-bold text-[11px] cursor-pointer appearance-none pr-4 text-gray-700">{MODELS.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
            <ChevronDown size={12} className="text-gray-400" />
          </div>
        </header>

        <div className="flex-1 overflow-y-auto custom-scrollbar bg-white">
          <div className="max-w-4xl mx-auto p-4 md:p-12 space-y-12">
            {currentSession?.messages.map((msg) => (
              <div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`w-full ${msg.role === "user" ? "max-w-[80%] ml-auto" : "max-w-none"}`}>
                  {msg.role === "user" ? (
                    <div className="bg-black text-white rounded-2xl px-5 py-3 shadow-sm ml-auto w-fit">
                       {msg.previewImages?.map((url, i) => <img key={i} src={url} className="max-w-xs rounded-xl border border-white/20 mb-2" alt="upload-preview" />)}
                       <p className="whitespace-pre-wrap text-[15px]">{msg.content}</p>
                    </div>
                  ) : (
                    <div className="bg-white text-gray-800">
                      {showReasoning && msg.reasoning && (
                        <div className="mb-8 bg-slate-50/80 rounded-2xl border border-slate-100 overflow-hidden shadow-sm">
                           <div className="flex items-center gap-2 px-5 py-3 text-slate-400 text-[11px] font-bold border-b border-slate-200/50"><BrainCircuit size={14} className="text-blue-400" /> 思考路径</div>
                           <div className="px-6 py-5 text-slate-500 text-[14px] italic opacity-80 markdown-container"><ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>{standardizeContent(msg.reasoning)}</ReactMarkdown></div>
                        </div>
                      )}
                      <div className={`markdown-container prose prose-slate max-w-none text-[16px] ${msg.isError ? 'text-red-500 bg-red-50 p-4 rounded-xl' : ''}`}>
                        <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>{standardizeContent(msg.content)}</ReactMarkdown>
                      </div>
                      {!msg.isError && <div className="mt-4 text-[10px] text-slate-300 italic flex items-center gap-1"><Check size={10} /> Powered by {msg.modelName}</div>}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {isLoading && (
              <div className="flex items-center gap-3 text-slate-400 text-[11px] font-bold py-3 px-4 bg-slate-50 w-fit rounded-full border border-gray-200">
                <Loader2 size={14} className="animate-spin text-black" />
                <div className="flex items-center gap-1">
                  <Clock size={12} />
                  <span>已思考 {thinkSeconds}s</span>
                </div>
              </div>
            )}
            <div ref={scrollRef} className="h-24" />
          </div>
        </div>

        {/* 底部输入框：其顶部 border-t 与左侧设置栏彻底在同一高度水平对齐 */}
        <footer className="p-4 bg-white border-t border-gray-200 shrink-0">
          <div className="max-w-4xl mx-auto flex flex-col gap-3">
            {attachments.length > 0 && (
              <div className="flex gap-3 p-3 bg-slate-50 rounded-2xl border-2 border-dashed border-slate-200 overflow-x-auto shadow-inner">
                {attachments.map(att => (
                  <div key={att.id} className="relative w-16 h-16 flex-shrink-0 group">
                    {att.type === 'image' ? (
                      <img src={att.preview} className="w-full h-full object-cover rounded-xl border-2 border-white shadow-sm" alt="upload-thumbnail" />
                    ) : (
                      <div className="w-full h-full bg-white rounded-xl flex flex-col items-center justify-center text-blue-500 border border-slate-200 shadow-sm">
                        <FileText size={24} />
                        <span className="text-[8px] font-bold truncate w-full px-1 text-center mt-1">{att.name}</span>
                      </div>
                    )}
                    <button onClick={() => setAttachments(prev => prev.filter(a => a.id !== att.id))} className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full p-1 shadow-xl"><X size={10} /></button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-end gap-2 bg-slate-100 p-2.5 rounded-[2rem] border border-gray-300 focus-within:bg-white focus-within:ring-4 focus-within:ring-slate-100 transition-all shadow-sm">
              <button onClick={() => fileInputRef.current?.click()} className="p-3 text-gray-400 hover:text-black transition-colors"><Paperclip size={22} /></button>
              <input type="file" ref={fileInputRef} onChange={handleFileChange} className="hidden" multiple accept="image/*,application/pdf" />
              <textarea rows={1} value={inputText} onChange={(e) => setInputText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), handleSend())} placeholder="发送消息..." className="flex-1 bg-transparent outline-none py-3 px-1 resize-none max-h-60 text-[15px]" />
              <button onClick={handleSend} disabled={isLoading} className="p-3.5 bg-black text-white rounded-full shadow-2xl disabled:bg-slate-300 transition-all"><Send size={22} /></button>
            </div>
          </div>
        </footer>
      </main>

      {/* --- 弹窗组件组 --- */}
      {isAuthOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[70] flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-sm rounded-3xl shadow-2xl p-8 space-y-6 relative">
            <div className="text-center space-y-2"><h2 className="text-2xl font-black">{authMode === 'login' ? '欢迎回来' : '开启云同步'}</h2><p className="text-slate-400 text-xs">登录后在所有设备共享聊天记忆</p></div>
            <div className="space-y-4">
              <input type="text" placeholder="用户名" className="w-full bg-slate-100 p-3 rounded-xl outline-none" value={authForm.user} onChange={e => setAuthForm({...authForm, user: e.target.value})} />
              <input type="password" placeholder="密码" className="w-full bg-slate-100 p-3 rounded-xl outline-none" value={authForm.pass} onChange={e => setAuthForm({...authForm, pass: e.target.value})} />
              <button onClick={handleAuth} className="w-full bg-black text-white p-3 rounded-xl font-bold hover:bg-slate-800 transition-all">{authMode === 'login' ? '立即登录' : '立即注册'}</button>
            </div>
            <button onClick={() => setAuthMode(authMode === 'login' ? 'register' : 'login')} className="w-full text-blue-600 text-xs font-bold underline">{authMode === 'login' ? '没有账号？去注册' : '已有账号？去登录'}</button>
            <button onClick={() => setIsAuthOpen(false)} className="absolute top-4 right-4 text-slate-300 hover:text-black"><X size={24} /></button>
          </div>
        </div>
      )}

      {isBrainOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-2xl rounded-3xl shadow-2xl flex flex-col h-[70vh]">
            <div className="p-6 border-b border-gray-100 flex items-center justify-between bg-blue-50/50"><h2 className="font-bold text-xl flex items-center gap-2 text-blue-700"><Brain size={24} /> 长期记忆</h2><button onClick={() => setIsBrainOpen(false)} className="text-slate-400 hover:text-black transition-all"><X size={24} /></button></div>
            <div className="flex-1 p-6"><textarea className="w-full h-full bg-slate-50 p-4 rounded-2xl outline-none border border-gray-200 text-sm leading-relaxed" value={longTermMemory} onChange={(e) => setLongTermMemory(e.target.value)} /></div>
            <div className="p-6 bg-gray-50 border-t border-gray-100 flex gap-3"><button onClick={() => setIsBrainOpen(false)} className="flex-1 bg-black text-white p-3 rounded-xl font-bold shadow-lg">确定并保存</button></div>
          </div>
        </div>
      )}

      {isSettingsOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-md rounded-3xl shadow-2xl overflow-hidden">
            <div className="p-6 border-b border-gray-100 bg-gray-50 flex items-center justify-between"><h2 className="font-bold text-xl flex items-center gap-2 text-gray-800"><Settings size={20} /> 设置中心</h2><button onClick={() => setIsSettingsOpen(false)} className="text-slate-400 hover:text-black transition-all"><X size={24} /></button></div>
            <div className="p-6 space-y-4">
              <div className="space-y-1"><label className="text-[10px] font-bold text-slate-400 uppercase ml-1">Gemini API Key</label><div className="relative"><input type={showKeys ? "text" : "password"} value={geminiKey} onChange={(e) => setGeminiKey(e.target.value)} className="w-full bg-slate-100 p-3 pr-12 rounded-xl outline-none focus:ring-2 focus:ring-black" /><button onClick={() => setShowKeys(!showKeys)} className="absolute right-3 top-3 text-slate-400">{showKeys ? <EyeOff size={18} /> : <Eye size={18} />}</button></div></div>
              <div className="space-y-1"><label className="text-[10px] font-bold text-slate-400 uppercase ml-1">DeepSeek API Key</label><div className="relative"><input type={showKeys ? "text" : "password"} value={deepseekKey} onChange={(e) => setDeepseekKey(e.target.value)} className="w-full bg-slate-100 p-3 pr-12 rounded-xl outline-none focus:ring-2 focus:ring-black" /><button onClick={() => setShowKeys(!showKeys)} className="absolute right-3 top-3 text-slate-400">{showKeys ? <EyeOff size={18} /> : <Eye size={18} />}</button></div></div>
              <div className="flex items-center justify-between p-3 bg-slate-100 rounded-2xl"><div className="text-sm font-bold flex items-center gap-2"><BrainCircuit size={16} className="text-blue-500" /> 显示思考过程</div><button onClick={() => setShowReasoning(!showReasoning)} className={`w-10 h-5 rounded-full relative transition-colors ${showReasoning ? 'bg-black' : 'bg-slate-300'}`}><div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all ${showReasoning ? 'left-5' : 'left-1'}`} /></button></div>
              <div className="flex items-center justify-between p-3 bg-slate-100 rounded-2xl"><div className="text-sm font-bold flex items-center gap-2">{autoUpdateBrain ? <Zap size={16} className="text-amber-500" /> : <ZapOff size={16} className="text-slate-400" />} 自动提炼长期记忆</div><button onClick={() => setAutoUpdateBrain(!autoUpdateBrain)} className={`w-10 h-5 rounded-full relative transition-colors ${autoUpdateBrain ? 'bg-amber-500' : 'bg-slate-300'}`}><div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all ${autoUpdateBrain ? 'left-5' : 'left-1'}`} /></button></div>
            </div>
            <div className="p-6 bg-gray-50 border-t border-gray-100 flex gap-3">
              <button onClick={() => setIsSettingsOpen(false)} className="flex-1 bg-white border border-gray-200 p-3 rounded-xl font-bold text-sm">取消</button>
              <button onClick={saveSettings} className="flex-1 bg-black text-white p-3 rounded-xl font-bold shadow-lg text-sm flex items-center justify-center gap-2">
                <Save size={16} /> 保存配置
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}