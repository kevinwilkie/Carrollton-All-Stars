/*
 * Settings — reached from the ☰ menu. Appearance (theme, moved out of the
 * header), your team profile (name / picture / slogan), and account (sign out).
 */
"use strict";

function renderSettings() {
  const host = $("#view-settings");
  const email = Auth.user && Auth.user.email;
  const t = App.myTeamId ? (App.teams[App.myTeamId] || {}) : null;

  const appearance =
    `<div class="card"><h3>Appearance</h3>` +
    `<p class="hint">Switch between the Classic dark look and the Vintage logo palette (saved on this device).</p>` +
    `<button id="btn-theme" class="btn btn-ghost"></button></div>`;

  const teamCard = App.myTeamId
    ? `<div class="card"><h3>My Team</h3>` +
      `<div class="set-team-preview">${teamAvatarHTML(App.myTeamId, 54)}` +
      `<div><b>${escapeHtml(teamName(App.myTeamId))}</b>` +
      `<div class="sub">${escapeHtml((t && t.slogan) || "")}</div></div></div>` +
      `<div class="set-fields">` +
      `<label for="set-name">Team name</label>` +
      `<input type="text" id="set-name" maxlength="40" value="${escapeHtml((t && t.name) || teamName(App.myTeamId))}" />` +
      `<label for="set-logo">Team picture (image URL)</label>` +
      `<input type="url" id="set-logo" placeholder="https://…/logo.png" value="${escapeHtml((t && t.logoUrl) || "")}" />` +
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

  wireThemeButton($("#btn-theme"));
  const si = $("#set-signin"); if (si) si.addEventListener("click", signInGoogle);
  const so = $("#set-signout"); if (so) so.addEventListener("click", signOutUser);

  const save = $("#set-save");
  if (save) save.addEventListener("click", async () => {
    const name = $("#set-name").value.trim();
    const logoUrl = $("#set-logo").value.trim();
    const slogan = $("#set-slogan").value.trim();
    const err = (m) => { const el = $("#set-error"); el.textContent = m; el.hidden = false; };
    if (!name) return err("Team name can't be empty.");
    if (logoUrl && !/^https?:\/\//i.test(logoUrl)) return err("Picture must be a full http(s) image URL.");
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
