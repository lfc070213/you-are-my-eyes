import "./App.css";
import { useState, useRef, useEffect } from "react";
import { Send, Paperclip, Plus, MessageSquare, Loader2, ChevronDown, X, FileText, Trash2, Settings, Eye, EyeOff, Save } from "lucide-react";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf";

pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@3.11.174/legacy/build/pdf.worker.min.js`;

// --- 数据结构定义 ---
interface Attachment {
  id: string;
  type: 'image' | 'pdf';
  name: string;
  mimeType: string;
  displayUrl: string; 
  apiBase64: string;   
  extractedText?: string;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments?: { type: 'image' | 'pdf', url: string, name: string }[];
}

interface ChatSession {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
}

export default function App() {
  // 会话与设置状态
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  
  // API Key 状态 (优先从本地读取，如果没有则尝试从环境变量读取)
  const [geminiKey, setGeminiKey] = useState(localStorage.getItem("eye_gemini_key") || import.meta.env.VITE_GEMINI_API_KEY || "");
  const [deepseekKey, setDeepseekKey] = useState(localStorage.getItem("eye_deepseek_key") || import.meta.env.VITE_DEEPSEEK_API_KEY || "");
  const [showKeys, setShowKeys] = useState(false);

  const [selectedModel, setSelectedModel] = useState(MODELS[0]);
  const [inputText, setInputText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const savedSessions = localStorage.getItem("eyes_sessions_v1");
    if (savedSessions) {
      const parsed = JSON.parse(savedSessions);
      setSessions(parsed);
      if (parsed.length > 0) setCurrentSessionId(parsed[0].id);
    } else {
      createNewSession();
    }
  }, []);

  useEffect(() => {
    if (sessions.length > 0) {
      localStorage.setItem("eyes_sessions_v1", JSON.stringify(sessions));
    }
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [sessions]);

  const currentSession = sessions.find(s => s.id === currentSessionId) || null;

  // --- 逻辑：保存设置 ---
  const saveSettings = () => {
    localStorage.setItem("eye_gemini_key", geminiKey);
    localStorage.setItem("eye_deepseek_key", deepseekKey);
    setIsSettingsOpen(false);
    alert("设置已保存！");
  };

  const createNewSession = () => {
    const newId = Date.now().toString();
    const newSession: ChatSession = { id: newId, title: "新对话", messages: [], createdAt: Date.now() };
    setSessions([newSession, ...sessions]);
    setCurrentSessionId(newId);
    setAttachments([]);
    setInputText("");
  };

  const deleteSession = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const newSessions = sessions.filter(s => s.id !== id);
    setSessions(newSessions);
    if (currentSessionId === id) setCurrentSessionId(newSessions.length > 0 ? newSessions[0].id : null);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    setIsProcessing(true);
    for (const file of Array.from(files)) {
      const reader = new FileReader();
      await new Promise<void>((resolve) => {
        reader.onload = async (ev) => {
          const fullBase64 = ev.target?.result as string;
          const pureBase64 = fullBase64.replace(/^data:.*?;base64,/, "").replace(/[\r\n\s]/g, "");
          let text = "";
          if (file.type === "application/pdf") {
            try {
              const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), useWorkerFetch: false });
              const pdf = await loadingTask.promise;
              for (let i = 1; i <= pdf.numPages; i++) {
                const page = await pdf.getPage(i);
                const content = await page.getTextContent();
                text += content.items.map((it: any) => it.str).join(" ") + "\n";
              }
            } catch (err) { text = "[PDF 解析失败]"; }
          }
          const newAtt: Attachment = { id: Math.random().toString(36).substr(2, 9), type: file.type.startsWith("image/") ? "image" : "pdf", name: file.name, displayUrl: fullBase64, apiBase64: pureBase64, mimeType: file.type || 'image/jpeg', extractedText: text };
          setAttachments(prev => [...prev, newAtt]);
          resolve();
        };
        reader.readAsDataURL(file);
      });
    }
    setIsProcessing(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleSend = async () => {
    // 发送前检查 Key
    const activeKey = selectedModel.provider === 'google' ? geminiKey : deepseekKey;
    if (!activeKey) {
      alert(`请先在设置中配置 ${selectedModel.name} 的 API Key`);
      setIsSettingsOpen(true);
      return;
    }

    if ((!inputText.trim() && attachments.length === 0) || isLoading || !currentSessionId) return;

    const currentAtts = [...attachments];
    const userText = inputText.trim() || (currentAtts.length > 0 ? "分析这个附件。" : "");
    const userMsg: Message = { id: Date.now().toString(), role: "user", content: userText, attachments: currentAtts.map(a => ({ type: a.type, url: a.displayUrl, name: a.name })) };
    const updatedSessions = sessions.map(s => {
      if (s.id === currentSessionId) {
        const newMessages = [...s.messages, userMsg];
        const newTitle = s.messages.length === 0 ? userText.slice(0, 15) : s.title;
        return { ...s, messages: newMessages, title: newTitle };
      }
      return s;
    });
    setSessions(updatedSessions);
    const history = updatedSessions.find(s => s.id === currentSessionId)?.messages || [];
    setInputText("");
    setAttachments([]);
    setIsLoading(true);

    try {
      let replyText = "";
      if (selectedModel.provider === "google") {
        const contents = history.map(msg => ({
          role: msg.role === "user" ? "user" : "model",
          parts: [{ text: msg.content }, ...(msg.id === userMsg.id ? currentAtts.map(att => ({ inline_data: { mime_type: att.mimeType, data: att.apiBase64 } })) : [])]
        }));
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${selectedModel.id}:generateContent?key=${geminiKey}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error.message);
        replyText = data.candidates[0].content.parts[0].text;
      } else {
        const dsMessages = history.map(msg => {
          let textContent = msg.content;
          if (msg.id === userMsg.id && currentAtts.length > 0) {
            let fileInfo = "\n【文件内容注入】:\n";
            currentAtts.forEach(att => {
              if (att.type === 'pdf') fileInfo += `[PDF文本]: ${att.extractedText}\n`;
            });
            textContent = fileInfo + "\n用户提议: " + textContent;
          }
          return { role: msg.role, content: textContent };
        });
        const res = await fetch("https://api.deepseek.com/chat/completions", {
          method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${deepseekKey}` },
          body: JSON.stringify({ model: selectedModel.id, messages: dsMessages })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error.message);
        replyText = data.choices[0].message.content;
      }
      setSessions(prev => prev.map(s => {
        if (s.id === currentSessionId) return { ...s, messages: [...s.messages, { id: Date.now().toString(), role: "assistant", content: replyText }] };
        return s;
      }));
    } catch (err: any) {
      alert("请求失败: " + err.message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex h-screen bg-white text-gray-900 font-sans relative">
      
      {/* 侧边栏 */}
      <div className="w-64 bg-slate-50 border-r flex flex-col">
        <div className="p-4">
          <button onClick={createNewSession} className="w-full flex items-center justify-center gap-2 bg-black text-white p-3 rounded-xl hover:bg-slate-800 font-bold text-sm shadow-md transition-all">
            <Plus size={18} /> 新建对话
          </button>
        </div>
        
        <div className="flex-1 overflow-y-auto px-2 space-y-1">
          {sessions.map(s => (
            <div key={s.id} onClick={() => setCurrentSessionId(s.id)} className={`group flex items-center justify-between p-3 rounded-xl cursor-pointer transition-all ${currentSessionId === s.id ? 'bg-white shadow-sm' : 'hover:bg-slate-200/50'}`}>
              <div className="flex items-center gap-3 overflow-hidden">
                <MessageSquare size={16} className={currentSessionId === s.id ? 'text-black' : 'text-slate-400'} />
                <span className={`text-sm truncate ${currentSessionId === s.id ? 'font-bold text-black' : 'text-slate-600'}`}>{s.title}</span>
              </div>
              <button onClick={(e) => deleteSession(s.id, e)} className="opacity-0 group-hover:opacity-100 p-1 hover:text-red-500 transition-all"><Trash2 size={14} /></button>
            </div>
          ))}
        </div>

        {/* 侧边栏底部：设置按钮 */}
        <div className="p-4 border-t">
          <button onClick={() => setIsSettingsOpen(true)} className="w-full flex items-center gap-2 text-slate-500 hover:text-black p-2 rounded-lg hover:bg-slate-200 transition-all text-sm">
            <Settings size={18} /> 设置
          </button>
        </div>
      </div>

      {/* 主界面 */}
      <div className="flex-1 flex flex-col">
        <header className="h-14 border-b flex items-center justify-center px-4 bg-white/80 backdrop-blur-md sticky top-0 z-10">
          <div className="flex items-center gap-2 bg-slate-100 px-4 py-1.5 rounded-full border border-slate-200">
            <select value={selectedModel.id} onChange={(e) => setSelectedModel(MODELS.find(m => m.id === e.target.value)!)} className="bg-transparent outline-none font-bold text-[11px] cursor-pointer appearance-none pr-4">
              {MODELS.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
            <ChevronDown size={12} className="text-slate-400" />
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-4 md:px-20 space-y-6">
          {currentSession?.messages.map((msg) => (
            <div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[85%] rounded-2xl px-5 py-3 shadow-sm ${msg.role === "user" ? "bg-black text-white rounded-tr-none" : "bg-slate-100 text-slate-800 rounded-tl-none border"}`}>
                {msg.attachments?.map((att, i) => (
                  <div key={i} className="mb-2">
                    {att.type === 'image' ? <img src={att.url} className="max-w-xs rounded-xl border-4 border-white shadow-lg" /> : <div className="flex items-center gap-2 bg-blue-100 text-blue-600 p-2 rounded-lg text-xs font-bold border border-blue-200"><FileText size={16} /> {att.name}</div>}
                  </div>
                ))}
                <p className="whitespace-pre-wrap leading-relaxed text-[15px]">{msg.content}</p>
              </div>
            </div>
          ))}
          {isLoading && <div className="flex items-center gap-2 text-slate-400 text-[10px] font-bold animate-pulse px-4"><Loader2 size={12} className="animate-spin" /> {selectedModel.name} 思考中...</div>}
          <div ref={scrollRef} className="h-10" />
        </div>

        <div className="p-4 bg-white border-t">
          <div className="max-w-4xl mx-auto flex flex-col gap-3">
            {attachments.length > 0 && (
              <div className="flex gap-3 p-3 bg-slate-50 rounded-2xl border-2 border-dashed border-slate-200 overflow-x-auto">
                {attachments.map(att => (
                  <div key={att.id} className="relative w-16 h-16 flex-shrink-0 group">
                    {att.type === 'image' ? <img src={att.displayUrl} className="w-full h-full object-cover rounded-xl border-2 border-white shadow-md" /> : <div className="w-full h-full bg-white rounded-xl flex flex-col items-center justify-center text-blue-500 border-2 border-slate-100 shadow-md"><FileText size={24} /><span className="text-[8px] font-bold truncate w-full px-1 text-center mt-1">{att.name}</span></div>}
                    <button onClick={() => setAttachments(prev => prev.filter(a => a.id !== att.id))} className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full p-1 shadow-xl"><X size={10} /></button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-end gap-2 bg-slate-100 p-2 rounded-[2rem] border border-slate-200 focus-within:bg-white focus-within:ring-4 focus-within:ring-slate-100 transition-all shadow-inner">
              <button onClick={() => fileInputRef.current?.click()} className="p-3 text-slate-400 hover:text-black transition-colors"><Paperclip size={22} /></button>
              <input type="file" ref={fileInputRef} onChange={handleFileChange} className="hidden" multiple accept="image/*,application/pdf" />
              <textarea rows={1} value={inputText} onChange={(e) => setInputText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), handleSend())} placeholder="在此处开始新的对话..." className="flex-1 bg-transparent outline-none py-3 px-1 resize-none max-h-60 text-[15px]" />
              <button onClick={handleSend} disabled={isLoading || isProcessing} className="p-3.5 bg-black text-white rounded-full shadow-2xl disabled:bg-slate-300 transition-all"><Send size={22} /></button>
            </div>
          </div>
        </div>
      </div>

      {/* --- 设置弹窗界面 --- */}
      {isSettingsOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-md rounded-3xl shadow-2xl overflow-hidden">
            <div className="p-6 border-b flex items-center justify-between">
              <h2 className="font-bold text-xl flex items-center gap-2"><Settings size={20} /> 应用设置</h2>
              <button onClick={() => setIsSettingsOpen(false)} className="text-slate-400 hover:text-black transition-all"><X size={24} /></button>
            </div>
            <div className="p-6 space-y-6">
              {/* Gemini Key */}
              <div className="space-y-2">
                <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">Gemini API Key</label>
                <div className="relative">
                  <input 
                    type={showKeys ? "text" : "password"} 
                    value={geminiKey} 
                    onChange={(e) => setGeminiKey(e.target.value)}
                    placeholder="在此输入 Gemini API Key..."
                    className="w-full bg-slate-100 p-3 pr-12 rounded-xl outline-none focus:ring-2 focus:ring-black transition-all"
                  />
                  <button onClick={() => setShowKeys(!showKeys)} className="absolute right-3 top-3 text-slate-400 hover:text-black">
                    {showKeys ? <EyeOff size={20} /> : <Eye size={20} />}
                  </button>
                </div>
              </div>

              {/* DeepSeek Key */}
              <div className="space-y-2">
                <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">DeepSeek API Key</label>
                <div className="relative">
                  <input 
                    type={showKeys ? "text" : "password"} 
                    value={deepseekKey} 
                    onChange={(e) => setDeepseekKey(e.target.value)}
                    placeholder="在此输入 DeepSeek API Key..."
                    className="w-full bg-slate-100 p-3 pr-12 rounded-xl outline-none focus:ring-2 focus:ring-black transition-all"
                  />
                  <button onClick={() => setShowKeys(!showKeys)} className="absolute right-3 top-3 text-slate-400 hover:text-black">
                    {showKeys ? <EyeOff size={20} /> : <Eye size={20} />}
                  </button>
                </div>
              </div>

              <p className="text-[10px] text-slate-400 leading-relaxed italic">
                * 您的 API Key 会安全地存储在本地设备中，不会被上传到任何第三方服务器。
              </p>
            </div>
            <div className="p-6 bg-slate-50 border-t flex gap-3">
              <button onClick={() => setIsSettingsOpen(false)} className="flex-1 bg-white border p-3 rounded-xl font-bold hover:bg-slate-100 transition-all">取消</button>
              <button onClick={saveSettings} className="flex-1 bg-black text-white p-3 rounded-xl font-bold flex items-center justify-center gap-2 hover:bg-slate-800 transition-all shadow-lg">
                <Save size={18} /> 保存配置
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

// 修正：模型列表定义需要放在组件外部或使用 useRef
const MODELS = [
  { id: "gemini-3.1-flash-lite", name: "gemini-3.1-flash-lite", provider: "google" },
  { id: "gemini-3-flash-preview", name: "gemini-3-flash-preview", provider: "google" },
  { id: "gemini-3.1-pro-preview", name: "gemini-3.1-pro-preview", provider: "google" },
  { id: "deepseek-v4-flash", name: "deepseek-v4-flash", provider: "deepseek" },
  { id: "deepseek-v4-pro", name: "deepseek-v4-pro", provider: "deepseek" },
];