// Messages thread component for shipment tracking page.
// Renders into a target element. Subscribes to realtime if Supabase is online.

window.MessagesUI = {
  _channel: null,

  async render(target, trackingCode) {
    target.innerHTML = `
      <div class="messages-section">
        <h3 data-i18n="msg_section_title">${window.t("msg_section_title")}</h3>
        <p class="sub" data-i18n="msg_section_sub">${window.t("msg_section_sub")}</p>

        <div class="message-list" id="msgList"></div>

        <form class="message-form" id="msgForm">
          <div class="message-quick-actions">
            <button type="button" class="btn btn-outline btn-sm" id="quickArrival">
              ${window.t("msg_arrival_btn")}
            </button>
            <button type="button" class="btn btn-outline btn-sm" id="quickPickup">
              ${window.t("msg_pickup_btn")}
            </button>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label>${window.t("msg_role")}</label>
              <select id="msgRole" required>
                <option value="sender">${window.t("msg_role_sender")}</option>
                <option value="receiver">${window.t("msg_role_receiver")}</option>
                <option value="agent_origin">${window.t("msg_role_agent_origin")}</option>
                <option value="agent_destination">${window.t("msg_role_agent_destination")}</option>
              </select>
            </div>
            <div class="form-group">
              <label>${window.t("msg_your_name")}</label>
              <input type="text" id="msgName" required />
            </div>
          </div>
          <div class="form-group">
            <textarea id="msgInput" required placeholder="${window.t("msg_input_placeholder")}"></textarea>
          </div>
          <button type="submit" class="btn btn-green">${window.t("msg_send")}</button>
        </form>
      </div>
    `;

    const listEl = target.querySelector("#msgList");
    const form = target.querySelector("#msgForm");

    const refresh = async () => {
      const messages = await window.DataStore.getMessages(trackingCode);
      if (messages.length === 0) {
        listEl.innerHTML = `<div class="message-empty">${window.t("msg_empty")}</div>`;
        return;
      }
      const roleLabel = (r) => window.t("msg_role_" + r) || r;
      listEl.innerHTML = messages.map(m => `
        <div class="message-item from-${m.from_role}">
          <div class="message-meta">
            <span><strong>${m.from_name}</strong> &middot; ${roleLabel(m.from_role)}</span>
            <span>${new Date(m.created_at).toLocaleString()}</span>
          </div>
          <div class="message-text">${escapeHtml(m.message)}</div>
        </div>
      `).join("");
      listEl.scrollTop = listEl.scrollHeight;
    };

    const escapeHtml = (s) => s
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    await refresh();

    // Subscribe to realtime
    if (this._channel) this._channel.unsubscribe?.();
    this._channel = window.DataStore.subscribeMessages(trackingCode, refresh);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const role = form.querySelector("#msgRole").value;
      const name = form.querySelector("#msgName").value.trim();
      const text = form.querySelector("#msgInput").value.trim();
      if (!name || !text) return;
      try {
        await window.DataStore.addMessage(trackingCode, role, name, text);
        form.querySelector("#msgInput").value = "";
        if (!window.DataStore.isOnline) await refresh();
      } catch (err) {
        alert("Failed to send message: " + err.message);
      }
    });

    // Quick action buttons
    target.querySelector("#quickArrival").addEventListener("click", async () => {
      const role = form.querySelector("#msgRole").value;
      const name = form.querySelector("#msgName").value.trim();
      if (!name) { alert(window.t("msg_your_name") + ": ?"); return; }
      await window.DataStore.addMessage(trackingCode, role, name, window.t("msg_arrival_text"));
      await window.DataStore.updateShipmentStatus(trackingCode, "Arrived");
      if (!window.DataStore.isOnline) await refresh();
    });

    target.querySelector("#quickPickup").addEventListener("click", async () => {
      const role = form.querySelector("#msgRole").value;
      const name = form.querySelector("#msgName").value.trim();
      if (!name) { alert(window.t("msg_your_name") + ": ?"); return; }
      await window.DataStore.addMessage(trackingCode, role, name, window.t("msg_pickup_text"));
      await window.DataStore.updateShipmentStatus(trackingCode, "Delivered");
      if (!window.DataStore.isOnline) await refresh();
    });
  },

  cleanup() {
    if (this._channel) {
      this._channel.unsubscribe?.();
      this._channel = null;
    }
  }
};
