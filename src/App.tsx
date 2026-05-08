import "./App.css";
import { useState, useRef, useEffect } from "react";
import { Send, Paperclip, Plus, MessageSquare, Loader2, ChevronDown, X, FileText } from "lucide-react";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf";

// 设置 PDF Worker (确保 DeepSeek 能读到文字)
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@3.11.174/legacy/build/pdf.worker.min.js`;

// ==========================================
// ⚠️ 填入你的 API KEY
// ==========================================
// 自动从 .env 文件中读取，不会暴露在代码仓库里
const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY;
const DEEPSEEK_API_KEY = import.meta.env.VITE_DEEPSEEK_API_KEY;

const MODELS = [
  { id: "gemini-3.1-flash-lite", name: "gemini-3.1-flash-lite", provider: "google" },
  { id: "gemini-3-flash-preview", name: "gemini-3-flash-preview", provider: "google" },
  { id: "gemini-3.1-pro-preview", name: "gemini-3.1-pro-preview", provider: "google" },
  { id: "deepseek-v4-flash", name: "deepseek-v4-flash", provider: "deepseek" },
  { id: "deepseek-v4-pro", name: "deepseek-v4-pro", provider: "deepseek" },
];

interface Attachment {
  id: string;
  type: 'image' | 'pdf';
  name: string;
  displayUrl: string; 
  apiBase64: string;   
  mimeType: string;
  extractedText?: string; // 专门给 DeepSeek 准备的文本
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments?: { type: 'image' | 'pdf', url: string, name: string }[];
}

export default function App() {
  const [selectedModel, setSelectedModel] = useState(MODELS[0]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const saved = localStorage.getItem("shared_memory_v5");
    if (saved) setMessages(JSON.parse(saved));
  }, []);

  useEffect(() => {
    localStorage.setItem("shared_memory_v5", JSON.stringify(messages));
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ================= 文件处理 (增加文字提取逻辑) =================
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    setIsProcessing(true);
    for (const file of Array.from(files)) {
      const reader = new FileReader();
      await new Promise<void>((resolve) => {
        reader.onload = async (ev) => {
          const fullBase64 = ev.target?.result as string;
          const pureBase64 = fullBase64.replace(/^data:.*?;base64,/, "").replace(/\s/g, "");
          
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
            } catch (err) { text = "[PDF 文字提取失败]"; }
          }

          const newAtt: Attachment = {
            id: Math.random().toString(36).substr(2, 9),
            type: file.type.startsWith("image/") ? "image" : "pdf",
            name: file.name,
            displayUrl: fullBase64,
            apiBase64: pureBase64,
            mimeType: file.type || 'image/jpeg',
            extractedText: text
          };
          setAttachments(prev => [...prev, newAtt]);
          resolve();
        };
        reader.readAsDataURL(file);
      });
    }
    setIsProcessing(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // ================= 发送消息 (重点修复 DeepSeek 注入) =================
  const handleSend = async () => {
    if ((!inputText.trim() && attachments.length === 0) || isLoading) return;

    const currentAtts = [...attachments];
    const userText = inputText.trim() || (currentAtts.length > 0 ? "分析一下这个文件。" : "");
    
    // UI 记录
    const userMsg: Message = {
      id: Date.now().toString(),
      role: "user",
      content: userText,
      attachments: currentAtts.map(a => ({ type: a.type, url: a.displayUrl, name: a.name }))
    };

    const newHistory = [...messages, userMsg];
    setMessages(newHistory);
    setInputText("");
    setAttachments([]);
    setIsLoading(true);

    try {
      let replyText = "";

      if (selectedModel.provider === "google") {
        // --- Gemini 原生模式 ---
        const contents = newHistory.map(msg => ({
          role: msg.role === "user" ? "user" : "model",
          parts: [
            { text: msg.content },
            ...(msg.id === userMsg.id ? currentAtts.map(att => ({
              inline_data: { mime_type: att.mimeType, data: att.apiBase64 }
            })) : [])
          ]
        }));
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${selectedModel.id}:generateContent?key=${GEMINI_API_KEY}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error.message);
        replyText = data.candidates[0].content.parts[0].text;

      } else {
        // --- DeepSeek 文本注入模式 (实现记忆共享) ---
        const dsMessages = newHistory.map(msg => {
          let textContent = msg.content;
          
          // 如果是刚才发的那条，且带附件，把内容抠出来塞进文字里
          if (msg.id === userMsg.id && currentAtts.length > 0) {
            let fileInfo = "\n\n【附件内容注入】:\n";
            currentAtts.forEach(att => {
              if (att.type === 'pdf') fileInfo += `--- PDF文本(${att.name}): ${att.extractedText}\n`;
              else fileInfo += `--- 图片附件(${att.name}): [当前模型无法查看图像，请切换到 Gemini 获取图像描述后，我会根据记忆继续回答]\n`;
            });
            textContent = fileInfo + "\n用户提问: " + textContent;
          }
          return { role: msg.role, content: textContent };
        });

        const res = await fetch("https://api.deepseek.com/chat/completions", {
          method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${DEEPSEEK_API_KEY}` },
          body: JSON.stringify({ model: selectedModel.id, messages: dsMessages })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error.message);
        replyText = data.choices[0].message.content;
      }

      setMessages(prev => [...prev, { id: Date.now().toString(), role: "assistant", content: replyText }]);
    } catch (err: any) {
      setMessages(prev => [...prev, { id: Date.now().toString(), role: "assistant", content: `[请求失败]: ${err.message}` }]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex h-screen bg-white text-gray-900 font-sans">
      <div className="w-64 bg-slate-50 border-r flex flex-col p-4">
        <button onClick={() => { setMessages([]); localStorage.removeItem("shared_memory_v5"); }} className="flex items-center justify-center gap-2 bg-white border shadow-sm p-3 rounded-2xl hover:bg-slate-100 font-bold mb-4">
          <Plus size={18} /> 新建对话
        </button>
        <div className="flex-1 overflow-y-auto text-[10px] text-slate-400 italic">
          记忆已持久化存档。你可以随时关闭并重新打开此程序。
        </div>
      </div>

      <div className="flex-1 flex flex-col">
        <header className="h-14 border-b flex items-center justify-center px-4 bg-white/80 backdrop-blur-sm sticky top-0 z-10">
          <div className="flex items-center gap-2 bg-slate-100 px-4 py-1.5 rounded-full border border-slate-200">
            <select value={selectedModel.id} onChange={(e) => setSelectedModel(MODELS.find(m => m.id === e.target.value)!)} className="bg-transparent outline-none font-bold text-xs cursor-pointer appearance-none pr-4">
              {MODELS.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
            <ChevronDown size={14} className="text-slate-400" />
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-4 md:px-20 space-y-6">
          {messages.length === 0 && <div className="h-full flex items-center justify-center text-slate-300 text-xs font-medium italic">Gemini 负责看图看 PDF，DeepSeek 负责深度逻辑，记忆实时共享。</div>}
          {messages.map((msg) => (
            <div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[85%] rounded-2xl px-5 py-3 shadow-sm ${msg.role === "user" ? "bg-black text-white" : "bg-slate-100 text-slate-800 border"}`}>
                {msg.attachments?.map((att, i) => (
                  <div key={i} className="mb-2">
                    {att.type === 'image' ? <img src={att.url} className="max-w-xs rounded-xl border-4 border-white shadow-lg" /> : <div className="flex items-center gap-2 bg-blue-100 text-blue-600 p-2 rounded-lg text-xs font-bold border border-blue-200"><FileText size={16} /> {att.name}</div>}
                  </div>
                ))}
                <p className="whitespace-pre-wrap leading-relaxed text-[15px]">{msg.content}</p>
              </div>
            </div>
          ))}
          {(isLoading || isProcessing) && <div className="flex items-center gap-2 text-slate-400 text-[10px] font-bold animate-pulse"><Loader2 size={12} className="animate-spin" /> {isProcessing ? "正在解析文件内容..." : "AI 正在思考..."}</div>}
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
              <button onClick={() => fileInputRef.current?.click()} className="p-3 text-slate-400 hover:text-black"><Paperclip size={22} /></button>
              <input type="file" ref={fileInputRef} onChange={handleFileChange} className="hidden" multiple accept="image/*,application/pdf" />
              <textarea rows={1} value={inputText} onChange={(e) => setInputText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), handleSend())} placeholder="发送消息或文件..." className="flex-1 bg-transparent outline-none py-3 px-1 resize-none max-h-60 text-[15px]" />
              <button onClick={handleSend} disabled={isLoading || isProcessing} className="p-3.5 bg-black text-white rounded-full shadow-2xl disabled:bg-slate-300"><Send size={22} /></button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}