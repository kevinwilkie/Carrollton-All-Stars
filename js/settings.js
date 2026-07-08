/*
 * Settings — reached from the ☰ menu. Appearance (theme, moved out of the
 * header), your team profile (name / picture / slogan), and account (sign out).
 */
"use strict";

function renderSettings() {
  const host = $("#view-settings");
  const email = Auth.user && Auth.user.email;
  const t = App.myTeamId ? (App.teams[App.myTeamId] || {}) : null;

  const cur = currentTheme();
  const bases = THEME_BASES.map((b) =>
    `<button class="theme-swatch base${cur === b ? " on" : ""}" data-theme-id="${b}">${THEME_LABELS[b]}</button>`).join("");
  const teams = (typeof TEAMS !== "undefined" ? TEAMS : []).slice()
    .sort((a, b) => a.abbr.localeCompare(b.abbr)).map((tm) => {
      const c = (typeof TEAM_COLORS !== "undefined" && TEAM_COLORS[tm.abbr]) || {};
      const id = "mlb:" + tm.abbr;
      return `<button class="theme-swatch team${cur === id ? " on" : ""}" data-theme-id="${id}" ` +
        `title="${escapeHtml(tm.name)}" style="background:${c.primary || "#333"};` +
        `border-color:${c.secondary || c.primary || "#333"}">${tm.abbr}</button>`;
    }).join("");
  const appearance =
    `<div class="card"><h3>Appearance</h3>` +
    `<p class="hint">Pick a look — saved on this device.</p>` +
    `<div class="theme-row">${bases}</div>` +
    `<div class="pc-sec">MLB team colors</div>` +
    `<div class="theme-grid">${teams}</div></div>`;

  const teamCard = App.myTeamId
    ? `<div class="card"><h3>My Team</h3>` +
      `<div class="set-team-preview"><span id="set-logo-preview">${teamAvatarHTML(App.myTeamId, 54)}</span>` +
      `<div><b>${escapeHtml(teamName(App.myTeamId))}</b>` +
      `<div class="sub">${escapeHtml((t && t.slogan) || "")}</div></div></div>` +
      `<div class="set-fields">` +
      `<label for="set-name">Team name</label>` +
      `<input type="text" id="set-name" maxlength="40" value="${escapeHtml((t && t.name) || teamName(App.myTeamId))}" />` +
      `<label for="set-logo-file">Team picture — upload an image</label>` +
      `<input type="file" id="set-logo-file" accept="image/*" />` +
      `<label for="set-logo">…or paste an image URL</label>` +
      `<input type="url" id="set-logo" placeholder="https://…/logo.png" value="${escapeHtml((t && t.logoUrl && !/^data:/i.test(t.logoUrl) ? t.logoUrl : "") || "")}" />` +
      `<button type="button" id="set-logo-clear" class="tc-link">Remove picture</button>` +
      `<label for="set-slogan">Slogan / motto</label>` +
      `<input type="text" id="set-slogan" maxlength="60" value="${escapeHtml((t && t.slogan) || "")}" />` +
      `</div>` +
      `<p id="set-error" class="form-error" hidden></p>` +
      `<div class="modal-actions"><button id="set-save" class="btn btn-primary">Save team</button></div></div>`
    : `<div class="card"><h3>My Team</h3><p class="hint">Sign in with your team's Google account to edit your team.</p></div>`;

  const roleLabel = Auth.role === "commish" ? "Commissioner"
    : Auth.role === "owner" ? teamName(App.myTeamId) : "Guest";
  const account = email
    ? `<div class="card"><h3>Account</h3>` +
      `<p class="hint">Signed in as <b>${escapeHtml(email)}</b> · ${escapeHtml(roleLabel)}</p>` +
      `<button id="set-signout" class="btn btn-danger-ghost">Sign out</button></div>`
    : `<div class="card"><h3>Account</h3>` +
      `<p class="hint">You're browsing as a guest.</p>` +
      `<button id="set-signin" class="btn">Sign in with Google</button></div>`;

  host.innerHTML = `<div class="view-head"><h2>Settings</h2></div>` +
    `<div class="stack">${appearance}${teamCard}${account}</div>`;

  host.querySelectorAll("[data-theme-id]").forEach((b) =>
    b.addEventListener("click", () => { applyTheme(b.dataset.themeId); renderActive(); }));
  const si = $("#set-signin"); if (si) si.addEventListener("click", signInGoogle);
  const so = $("#set-signout"); if (so) so.addEventListener("click", signOutUser);

  const err = (m) => { const el = $("#set-error"); if (el) { el.textContent = m; el.hidden = false; } };
  const clearErr = () => { const el = $("#set-error"); if (el) el.hidden = true; };
  // An uploaded/removed picture overrides the URL field: null = "no change, use
  // the URL box"; a data: URI = the resized upload; "" = explicitly cleared.
  let pendingLogo = null;
  const setPreview = (src) => {
    const p = $("#set-logo-preview");
    if (!p) return;
    p.innerHTML = src
      ? `<span class="avatar has-photo" style="--sz:54px"><img src="${escapeHtml(src)}" alt=""></span>`
      : teamAvatarHTML(App.myTeamId, 54);
  };

  const file = $("#set-logo-file");
  if (file) file.addEventListener("change", async () => {
    const f = file.files && file.files[0];
    if (!f) return;
    if (!/^image\//.test(f.type)) return err("Please choose an image file.");
    try {
      pendingLogo = await resizeImageToDataUrl(f, 256);
      setPreview(pendingLogo);
      const url = $("#set-logo"); if (url) url.value = "";
      clearErr();
    } catch (e) { err(e.message || "Couldn't process that image."); }
  });
  const clearBtn = $("#set-logo-clear");
  if (clearBtn) clearBtn.addEventListener("click", () => {
    pendingLogo = "";
    if (file) file.value = "";
    const url = $("#set-logo"); if (url) url.value = "";
    setPreview("");
    clearErr();
  });

  const save = $("#set-save");
  if (save) save.addEventListener("click", async () => {
    const name = $("#set-name").value.trim();
    const urlVal = $("#set-logo").value.trim();
    const slogan = $("#set-slogan").value.trim();
    // Prefer an uploaded/removed picture; otherwise use whatever's in the URL box.
    const logoUrl = pendingLogo != null ? pendingLogo : urlVal;
    if (!name) return err("Team name can't be empty.");
    if (logoUrl && !/^(https?:\/\/|data:image\/)/i.test(logoUrl))
      return err("Picture must be an uploaded image or a full http(s) image URL.");
    save.disabled = true; save.textContent = "Saving…";
    try {
      await saveTeamProfile({ name, logoUrl: logoUrl || null, slogan: slogan || null });
      toast("Team updated.", "success");
      renderActive();
    } catch (e) {
      save.disabled = false; save.textContent = "Save team";
      err("Couldn't save: " + (e.message || "permission denied"));
    }
  });
}

// Resize an image File to a JPEG data: URI whose longest side is <= maxSide.
// Keeps the stored logo tiny (~10–30KB) so it fits a Firestore doc.
function resizeImageToDataUrl(file, maxSide) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Couldn't read that file."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("That file isn't a valid image."));
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        try { resolve(canvas.toDataURL("image/jpeg", 0.82)); }
        catch (e) { reject(new Error("Couldn't process that image.")); }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
