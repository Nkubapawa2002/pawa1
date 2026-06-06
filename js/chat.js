// Tab switching — AI / Voice AI / Support
window.switchChatTab = (tab) => {
  document.querySelectorAll(".chat-tab").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".chat-panel").forEach(p => p.classList.remove("active"));
  const tabMap   = { ai: "tabAi", voice: "tabVoice", support: "tabSupport" };
  const panelMap = { ai: "panelAi", voice: "panelVoice", support: "panelSupport" };
  document.getElementById(tabMap[tab])?.classList.add("active");
  document.getElementById(panelMap[tab])?.classList.add("active");
};

// Render support contacts list
window.renderSupportContacts = () => {
  const list = document.getElementById("supportContactsList");
  if (!list) return;
  const contacts = window.APP_CONFIG.SUPPORT_CONTACTS || [];
  if (!contacts.length) {
    list.innerHTML = `<div class="message-empty">${window.t("voice_no_booking")}</div>`;
    return;
  }
  list.innerHTML = contacts.map(c => {
    const roleLabel = window.t(c.role) || c.role;
    const phoneEncoded = encodeURIComponent(c.phone);
    return `
    <div class="support-contact-card">
      <div class="support-contact-icon">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
        </svg>
      </div>
      <div class="support-contact-info">
        <span class="role-label">${roleLabel}</span>
        <div class="contact-name">${c.name}</div>
        <div class="contact-phone">${c.phone}</div>
      </div>
      <div class="support-contact-actions">
        <a href="tel:${phoneEncoded}" class="btn btn-green btn-sm">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.63 3.35 2 2 0 0 1 3.6 1.13h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L7.91 8.73a16 16 0 0 0 6 6l.96-.96a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 21.73 16z"/>
          </svg>
          ${window.t("support_call")}
        </a>
        <a href="https://wa.me/${c.whatsapp}" target="_blank" rel="noopener" class="btn btn-whatsapp btn-sm">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51a12.8 12.8 0 0 0-.57-.01c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413z"/>
          </svg>
          ${window.t("support_whatsapp")}
        </a>
      </div>
    </div>`;
  }).join("");
};

window.initChatPage = async () => {
  const messagesEl = document.getElementById("chatMessages");
  const form = document.getElementById("chatForm");
  const input = document.getElementById("chatInput");
  const suggestions = document.getElementById("suggestions");
  const sendBtn = form.querySelector("button[type=submit]");

  let agents = [], buses = [], regions = [], shipments = [];
  try {
    [agents, buses, regions, shipments] = await Promise.all([
      window.DataStore.getAgents(),
      window.DataStore.getBuses(),
      window.DataStore.getRegions(),
      window.DataStore.getShipments()
    ]);
  } catch (e) {
    addMessage("system", "Could not load data: " + e.message);
  }

  const lang = window.getLang();

  // Conversation history shared with the ai-chat Edge Function.
  const conversation = [];

  function addMessage(role, text) {
    const div = document.createElement("div");
    div.className = `msg ${role}`;
    div.innerHTML = `<div class="msg-bubble">${formatMessage(text)}</div>`;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  const formatMessage = (text) =>
    text
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\n/g, "<br/>");

  addMessage("assistant", window.t("chat_greeting"));

  // window.AI (js/ai.js) wraps ai-chat / ai-think / ai-map. The API key
  // lives only in Supabase Edge Function secrets; the browser holds nothing.
  const cfg = window.APP_CONFIG || {};
  const haveAI = !!cfg.SUPABASE_URL && !!window.AI;

  // Stable system prompt: regions + buses + agents are folded in so Claude
  // can answer route/agent questions without tool calls. Kept large enough
  // (>1KB) so ai-chat marks it cacheable.
  const buildSystemPrompt = () => {
    const regionList = (regions || []).join(", ");
    const busLines = (buses || []).map(b => {
      const routes = (b.routes || []).map(r => `${r.from}->${r.to}`).join("; ");
      return `- ${b.name} (${b.contact}): ${routes}`;
    }).join("\n");
    const agentLines = (agents || []).slice(0, 40).map(a =>
      `- ${a.name} in ${a.region} (${a.terminal || "—"}): ${a.phone}`
    ).join("\n");
    const replyLang = lang === "sw" ? "Swahili (Kiswahili)" : "English";
    return `You are PAWA — the friendly AI assistant for Pawa, Tanzania's all-in-one platform for bus tickets, parcel cargo, house rentals & sales, moving trucks, and ride-hailing.

LANGUAGE: Always reply in the SAME language as the user's latest message — Swahili for Swahili, English for English. If a message mixes both or is unclear (greetings, numbers, place names only), reply in ${replyLang}. Stay in one language per reply — never mix the two, and never mention language.

PERSONALITY: Warm, friendly and genuinely helpful — like a well-connected local friend who knows every route, agent, neighbourhood and price by heart. Be encouraging and positive. A little warmth is welcome ("Karibu!", "Happy to help!"), but stay concise: answer in 1-3 short sentences or a tight bulleted list, and get to the useful answer quickly without empty filler.

WHAT PAWA OFFERS — you can help with ALL of these, so listen for what the user needs and guide them:
🚌 Bus tickets — find buses & routes, departure times and fares (use the BUS COMPANIES data below). To book, send them to the Book page (book-fast.html) or the bus company's number.
📦 Parcel cargo — track parcels by code (format TZ-XXX-XXX-YYYYMMDD-NNN), explain pricing & insurance, register a shipment via the Send Parcel page (send.html), and connect senders to agents (AGENTS data below).
🏠 Houses (rent & buy) — help people find a home on the Houses page (houses.html): they can filter by area, budget, bedrooms and listing type, browse on the map, tap "Near me", set area alerts, and use the "workplace / daily-route" tool to rank homes by how close they are to where they work. Each listing also shows nearby schools, hospitals, markets and transport by their real names. Property owners list their homes on agent-houses.html.
🚚 Moving trucks — help people find a moving/lorry truck on the Trucks page (trucks.html) to move house or transport goods; they can browse by region and call the owner directly. Truck owners list their trucks on agent-trucks.html.
🚕 Ride-hailing — riders can request a ride and drivers can go online on the Ride page (ride.html).

PRICING (parcels only): base ${cfg.FREIGHT_BASE_TZS || 2000} TZS + ${cfg.FREIGHT_PER_KG_TZS || 500} TZS/kg; size multipliers small×1, medium×1.5, large×2.5. Insurance covers ${cfg.INSURANCE_COVERAGE_PERCENT || 80}% of declared value.

RULES:
1. Never guess a parcel price — use the formula above. House, truck and ride prices are set by the owner/driver, so point the user to the listing or tell them to ask the owner directly rather than inventing a number.
2. Parse parcel tracking codes exactly as written.
3. For bus routes, search the BUS COMPANIES list first; if there's no direct route, suggest connections or the nearest option.
4. If a region has no agents, say so and offer the nearest region.
5. Always guide the user to the RIGHT next step — book a ticket, send a parcel, browse houses or trucks, request a ride, or call an agent/owner.
6. Don't have a specific live listing (a particular house, truck or driver)? Don't invent it — tell them exactly where to browse it and offer to help narrow the search.
7. In voice mode, keep replies to 2 sentences max.
8. Never say "as an AI" or break character.

REGIONS: ${regionList}

BUS COMPANIES:
${busLines || "(none loaded)"}

AGENTS (first 40):
${agentLines || "(none loaded)"}`;
  };
  const systemPrompt = buildSystemPrompt();
  window._pawaChatSystemPrompt = systemPrompt;

  const SUGGESTIONS = lang === "sw"
    ? [
        "Nataka kutuma mzigo Dar kwenda Mwanza",
        "Mawakala wa Arusha",
        "/map wakala wa karibu na Mwanza",
        "/think nipendekeze basi bora kutoka Dar kwenda Arusha"
      ]
    : [
        "Send a parcel from Dar to Mwanza",
        "Agents in Arusha",
        "/map nearest agent to Mwanza",
        "/think recommend the best bus from Dar to Arusha"
      ];

  SUGGESTIONS.forEach(s => {
    const chip = document.createElement("div");
    chip.className = "suggestion-chip";
    chip.textContent = s;
    chip.addEventListener("click", () => { input.value = s; form.requestSubmit(); });
    suggestions.appendChild(chip);
  });

  // Brain priority: (1) Gemini via secure proxy, (2) Supabase ai-chat,
  // (3) local regex demo. Each turn passes the full conversation.
  const haveGemini = !!window.GeminiChat && window.GeminiChat.available();

  const callAI = async (userText) => {
    conversation.push({ role: "user", content: userText });

    // 1) Gemini — primary brain, via the gemini-chat Edge Function (the key
    //    stays server-side; the function runs the model-fallback chain).
    if (haveGemini) {
      try {
        const reply = await window.GeminiChat.chat({
          models:      cfg.GEMINI_TEXT_MODELS,
          system:      systemPrompt,
          messages:    conversation,
          maxTokens:   1024,
          temperature: 0.6
        });
        if (reply) {
          conversation.push({ role: "assistant", content: reply });
          return reply;
        }
      } catch (e) {
        console.warn("[Gemini chat] falling back:", e.message);
      }
    }

    // 2) Supabase ai-chat (Anthropic) — secondary brain.
    if (haveAI) {
      try {
        const data = await window.AI.chat({
          messages: conversation,
          system: systemPrompt,
          max_tokens: 1024,
          temperature: 0.6
        });
        const reply = data.reply || "(no reply)";
        conversation.push({ role: "assistant", content: reply });
        return reply;
      } catch (e) {
        console.error(e);
      }
    }

    // 3) Local regex demo — last resort. Drop the failed user turn so a
    //    retry isn't stale.
    conversation.pop();
    return demoReply(userText);
  };

  // /map <query> — structured map intent via ai-map.
  const callMap = async (query) => {
    if (!haveAI) return "Map AI unavailable (configure Supabase).";
    try {
      const data = await window.AI.map({
        query,
        regions: regions || []
      });
      const i = data.intent || {};
      const lines = [`**Map intent:** ${i.kind || "unknown"}`];
      if (i.entity) lines.push(`**Entity:** ${i.entity}`);
      if (i.from?.name) lines.push(`**From:** ${i.from.name}`);
      if (i.to?.name)   lines.push(`**To:** ${i.to.name}`);
      if (i.region)     lines.push(`**Region:** ${i.region}`);
      if (i.answer)     lines.push("", i.answer);
      return lines.join("\n");
    } catch (e) {
      console.error(e);
      return `Map error: ${e.message}`;
    }
  };

  // /think <task> — structured decision via ai-think.
  const callThink = async (task) => {
    if (!haveAI) return "Decision AI unavailable (configure Supabase).";
    try {
      const data = await window.AI.think({
        task,
        context: {
          regions,
          buses: (buses || []).map(b => ({
            name: b.name,
            contact: b.contact,
            routes: (b.routes || []).map(r => `${r.from}->${r.to}`)
          })),
          agents: (agents || []).slice(0, 30).map(a => ({
            name: a.name, region: a.region, terminal: a.terminal, phone: a.phone
          }))
        },
        thinking: false,
        max_tokens: 1500
      });
      const r = data.result;
      if (r && typeof r === "object") {
        const decision = r.decision !== undefined ? `**Decision:** ${typeof r.decision === "string" ? r.decision : JSON.stringify(r.decision)}` : "";
        const reasoning = r.reasoning ? `**Reasoning:** ${r.reasoning}` : "";
        return [decision, reasoning].filter(Boolean).join("\n\n") || data.raw;
      }
      return data.raw || "(no decision)";
    } catch (e) {
      console.error(e);
      return `Think error: ${e.message}`;
    }
  };

  // Slash-command router. Falls back to plain chat for everything else.
  const dispatch = async (text) => {
    const m = text.match(/^\s*\/(map|think|chat)\s+([\s\S]+)$/i);
    if (!m) return callAI(text);
    const cmd = m[1].toLowerCase();
    const rest = m[2].trim();
    if (cmd === "map")   return callMap(rest);
    if (cmd === "think") return callThink(rest);
    return callAI(rest);
  };

  const demoReply = (text) => {
    const q  = text.toLowerCase();
    const sw = lang === "sw";

    const codeMatch = text.match(/TZ-[A-Z]{3}-[A-Z]{3}-\d{8}-\d{3}/i);
    if (codeMatch) {
      const s = shipments.find(x => x.tracking_code.toLowerCase() === codeMatch[0].toLowerCase());
      if (s) {
        const cov = Math.round((s.product.value_tzs || 0) * 0.8);
        return `**${s.tracking_code}**\n**Status:** ${s.status}\n**Route:** ${s.bus.route}\n**Bus:** ${s.bus.name}\n**Sender:** ${s.sender.name} (${s.sender.phone})\n**Receiver:** ${s.receiver.name} (${s.receiver.phone})\n**Value:** ${window.formatTZS(s.product.value_tzs)} | **Insured:** ${window.formatTZS(cov)}\n**Origin Agent:** ${s.agent_origin.name} - ${s.agent_origin.phone}\n**Dest Agent:** ${s.agent_destination.name} - ${s.agent_destination.phone}`;
      }
      return sw ? "Hakuna mzigo wenye namba hiyo." : "No shipment found with that code.";
    }

    const region = regions.find(r => q.includes(r.toLowerCase()));
    if ((q.includes("agent") || q.includes("wakala") || q.includes("mawakala")) && region) {
      const found = window.DataStore.findAgentsByRegion(agents, region);
      if (found.length === 0) return sw ? `Hakuna wakala ${region} kwa sasa.` : `No agents listed in ${region} yet.`;
      return `**${sw ? "Mawakala" : "Agents in"} ${region}:**\n` + found.map(a => `- ${a.name} (${a.terminal}) - ${a.phone}`).join("\n");
    }

    if (q.includes("send") || q.includes("tuma") || q.includes("from") || q.includes("kutoka")) {
      const found = regions.filter(r => q.includes(r.toLowerCase()));
      if (found.length >= 2) {
        const [from, to] = found;
        const matchingBuses = window.DataStore.findBusesForRoute(buses, from, to);
        if (matchingBuses.length === 0) return sw ? `Hakuna basi la ${from} → ${to}.` : `No bus found for ${from} → ${to}.`;
        return `**${sw ? "Mabasi" : "Buses for"} ${from} → ${to}:**\n` + matchingBuses.map(b => {
          const r = b.routes.find(x => x.from === from && x.to === to);
          return `- ${b.name} (${r.departure}, ~${r.duration_hours}h) - ${b.contact}`;
        }).join("\n") + (sw ? "\n\nBofya **Tuma Mzigo** kusajili." : "\n\nClick **Send Parcel** to register.");
      }
      return sw
        ? "Niambie mahali pa kuanzia na pa kufikia — mfano 'Tuma kutoka Dar kwenda Mwanza'."
        : "Tell me the origin and destination — e.g. 'Send from Dar to Mwanza'.";
    }

    if ((q.includes("bus") || q.includes("basi")) && region) {
      const matching = buses.filter(b => (b.routes || []).some(r => r.to === region || r.from === region));
      if (matching.length === 0) return sw ? `Hakuna mabasi yanayohudumia ${region}.` : `No buses found serving ${region}.`;
      return `**${sw ? "Mabasi ya" : "Buses serving"} ${region}:**\n` + matching.map(b => `- ${b.name} - ${b.contact}`).join("\n");
    }

    return lang === "sw"
      ? "Naweza kukusaidia: kupata basi, kupata wakala, kufuatilia mzigo, au kusajili usafirishaji. Unahitaji nini?"
      : "I can help with: finding a bus, finding an agent, tracking a parcel, registering a shipment, or explaining insurance. What would you like?";
  };

  // ── Voice assistant (Jarvis-inspired) ───────────────────────────────
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  const micBtn       = document.getElementById("chatMicBtn");
  const voiceModeBtn = document.getElementById("voiceModeBtn");
  const voiceBanner  = document.getElementById("voiceBanner");
  const voiceBannerText = document.getElementById("voiceBannerText");

  let recognition       = null;
  let voiceMode         = false;
  let voiceOutputOn     = false;
  let isListening       = false;
  let suppressAutoListen = false;

  const listeningLabel = lang === "sw" ? "Inasikiliza…" : "Listening…";
  const speakingLabel  = lang === "sw" ? "Pawa anasema…" : "Pawa is speaking…";

  function setBanner(text) {
    if (!voiceBanner) return;
    if (text) { voiceBannerText.textContent = text; voiceBanner.classList.add("show"); }
    else       { voiceBanner.classList.remove("show"); }
  }

  function speakReply(text, onDone) {
    if (!window.speechSynthesis || !voiceOutputOn) { onDone && onDone(); return; }
    window.speechSynthesis.cancel();
    const clean = text
      .replace(/\*\*/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/\n/g, " ")
      .trim()
      .substring(0, 500);
    const u = new SpeechSynthesisUtterance(clean);
    u.lang  = lang === "sw" ? "sw-TZ" : "en-US";
    u.rate  = 1.05;
    u.onstart = () => setBanner(speakingLabel);
    u.onend = () => {
      setBanner(null);
      onDone && onDone();
      if (voiceMode && recognition && !isListening && !suppressAutoListen) {
        setTimeout(() => { if (voiceMode) recognition.start(); }, 500);
      }
    };
    window.speechSynthesis.speak(u);
  }

  if (!SpeechRec) {
    micBtn && micBtn.classList.add("no-support");
  } else {
    recognition = new SpeechRec();
    recognition.lang = lang === "sw" ? "sw-TZ" : "en-US";
    recognition.continuous    = false;
    recognition.interimResults = true;

    recognition.onstart = () => {
      isListening = true;
      micBtn && micBtn.classList.add("listening");
      setBanner(listeningLabel);
    };

    recognition.onresult = (e) => {
      const transcript = Array.from(e.results).map(r => r[0].transcript).join("");
      input.value = transcript;
      if (e.results[e.results.length - 1].isFinal) {
        input.value = transcript;
        form.requestSubmit();
      }
    };

    recognition.onerror = (e) => {
      if (e.error !== "no-speech") console.warn("[Voice]", e.error);
      isListening = false;
      micBtn && micBtn.classList.remove("listening");
      setBanner(null);
    };

    recognition.onend = () => {
      isListening = false;
      micBtn && micBtn.classList.remove("listening");
      if (!voiceMode || suppressAutoListen) setBanner(null);
    };

    micBtn && micBtn.addEventListener("click", () => {
      if (isListening) { recognition.stop(); }
      else             { input.value = ""; recognition.start(); }
    });
  }

  voiceModeBtn && voiceModeBtn.addEventListener("click", () => {
    voiceMode    = !voiceMode;
    voiceOutputOn = voiceMode;
    voiceModeBtn.classList.toggle("active", voiceMode);
    voiceModeBtn.querySelector(".vmt-label").textContent =
      voiceMode
        ? (lang === "sw" ? "Sauti ON" : "Voice ON")
        : (lang === "sw" ? "Sauti" : "Voice");
    voiceModeBtn.title = voiceMode
      ? (lang === "sw" ? "Washa/zima hali ya sauti" : "Voice mode ON — click to disable")
      : (lang === "sw" ? "Washa hali ya sauti" : "Enable voice mode");

    if (voiceMode) {
      const greeting = lang === "sw"
        ? "Karibu! Hali ya sauti imewashwa. Niambie unachohitaji."
        : "Voice mode on. I'm Pawa — your Tanzania travel assistant. Ask me anything.";
      addMessage("assistant", greeting);
      speakReply(greeting);
    } else {
      window.speechSynthesis && window.speechSynthesis.cancel();
      recognition && recognition.stop();
      setBanner(null);
    }
  });
  // ── End voice assistant ──────────────────────────────────────────────

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    suppressAutoListen = true;
    if (isListening) recognition && recognition.stop();
    addMessage("user", text);
    input.value = "";
    sendBtn.disabled = true;
    sendBtn.textContent = "...";
    suggestions.style.display = "none";
    setBanner(null);

    const reply = await dispatch(text);
    addMessage("assistant", reply);
    sendBtn.disabled = false;
    sendBtn.textContent = window.t("chat_send");
    suppressAutoListen = false;
    speakReply(reply);
  });

  return systemPrompt;
};

// =============================================================
// Voice AI Tab — Gemini Live (Jarvis engine)
// =============================================================
window.initVoiceTab = (systemPrompt) => {
  const cfg        = window.APP_CONFIG || {};
  const baseUrl    = (cfg.SUPABASE_URL || "").replace(/\/$/, "");
  const anonKey    = cfg.SUPABASE_ANON_KEY || "";
  const tokenUrl   = baseUrl + (cfg.GEMINI_TOKEN_PATH || "/functions/v1/gemini-token");
  const model      = cfg.GEMINI_LIVE_MODEL;
  const lang       = window.getLang ? window.getLang() : "en";

  // Voice-specific addendum: the model hears speech, so anchor it to the
  // SPOKEN language and keep replies short (long spoken answers feel laggy).
  const voicePrompt = (systemPrompt || "") + `

VOICE MODE:
- Reply in the SAME language the user is SPEAKING. If they speak Swahili, answer in Swahili; if English, answer in English. Never switch languages mid-conversation unless the user does.
- Keep every spoken reply to 1-2 short sentences. Ask one question at a time.
- Speak numbers naturally (e.g. "tisini elfu shilingi", not "90000").`;

  const micBtn     = document.getElementById("vaMicBtn");
  const micRings   = document.getElementById("vaMicRings");
  const stateBadge = document.getElementById("vaStateBadge");
  const hintEl     = document.getElementById("vaHint");
  const messages   = document.getElementById("vaMessages");
  const textBar    = document.getElementById("vaTextBar");
  const textInput  = document.getElementById("vaTextInput");

  let assistant = null;

  // State labels
  const LABELS = {
    idle:       { en: "Tap to start voice conversation with Pawa", sw: "Bonyeza kuanza mazungumzo ya sauti" },
    connecting: { en: "Connecting to Pawa AI…",                    sw: "Inaunganika na Pawa AI…" },
    listening:  { en: "Listening — speak now",                     sw: "Inasikiliza — sema sasa" },
    thinking:   { en: "Pawa is thinking…",                         sw: "Pawa anafikiri…" },
    speaking:   { en: "Pawa is speaking…",                         sw: "Pawa anasema…" },
    error:      { en: "Connection error — tap to retry",           sw: "Hitilafu ya muunganiko — bonyeza tena" },
  };

  function addMsg(role, text) {
    if (!text || !messages) return;
    const d = document.createElement("div");
    d.className = `msg ${role}`;
    d.innerHTML = `<div class="msg-bubble">${text.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}</div>`;
    messages.appendChild(d);
    messages.scrollTop = messages.scrollHeight;
  }

  function setState(state) {
    if (!stateBadge) return;

    // Badge text + class
    stateBadge.className = `va-state-badge ${state}`;
    stateBadge.textContent = state.toUpperCase();

    // Hint text
    const hint = (LABELS[state] || LABELS.idle)[lang] || LABELS[state]?.en || "";
    if (hintEl) hintEl.textContent = hint;

    // Mic button visual
    if (!micBtn) return;
    micBtn.classList.remove("calling", "active-call");
    if (micRings) micRings.classList.remove("active");

    if (state === "listening" || state === "thinking") {
      micBtn.classList.add("calling");
      if (micRings) micRings.classList.add("active");
    } else if (state === "speaking") {
      micBtn.classList.add("active-call");
    }

    // Show text input once connected
    if (textBar) {
      textBar.classList.toggle("show", state !== "idle" && state !== "connecting" && state !== "error");
    }

    // Mic button icon: stop when active, mic when idle/error
    const stopIcon = `<svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`;
    const micIcon  = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`;
    micBtn.innerHTML = (state === "idle" || state === "error") ? micIcon : stopIcon;
  }

  // Tap mic = toggle on/off
  micBtn && micBtn.addEventListener("click", async () => {
    if (assistant) {
      assistant.stop();
      assistant = null;
      setState("idle");
      return;
    }

    if (!baseUrl || !anonKey) {
      addMsg("system", lang === "sw"
        ? "Huduma ya sauti haijawekwa (Supabase haijaundwa)."
        : "Voice service not configured (Supabase not set up).");
      return;
    }
    if (!window.PawaVoice) {
      addMsg("system", "gemini-voice.js not loaded.");
      return;
    }

    addMsg("assistant", lang === "sw"
      ? "Habari! Mimi ni Pawa. Ninaunganika…"
      : "Hello! I'm Pawa. Connecting…");

    assistant = new window.PawaVoice({
      tokenUrl,
      anonKey,
      model,
      systemPrompt: voicePrompt,
      onTranscript: (role, text) => addMsg(role, text),
      onState:      (s)          => setState(s),
    });

    await assistant.start();
  });

  // Text fallback input while session is live
  textBar && textBar.addEventListener("submit", (e) => {
    e.preventDefault();
    const t = textInput.value.trim();
    if (!t || !assistant) return;
    addMsg("user", t);
    textInput.value = "";
    assistant.sendText(t);
  });

  setState("idle");
};
