import { $, esc, fmtDate, fmtDur, fmtBytes } from '../util.js';
import { icons } from '../icons.js';
import { toast, confirmDialog } from '../ui.js';
import { listRecordings, restoreRecording, purgeRecording } from '../store.js';
import { T } from '../i18n.js';

export function mountTrash(root, ctx) {
  root.innerHTML = `
    <div class="view">
      <div class="simple-top">
        <button class="icon-btn" data-act="back" aria-label="${T('common.back')}">${icons.chevronLeft}</button>
        <div class="t">${T('trash.title')}</div>
        <div class="spacer"></div>
        <button class="ghost danger" data-act="empty">${T('trash.emptyBtn')}</button>
      </div>
      <div class="scroll" id="trashScroll">
        <div class="trash-actions" id="trashActions" style="display:none">
          <button class="ghost outline" data-act="restore-all">${T('trash.restoreAll')}</button>
        </div>
        <div class="list" id="trashList"></div>
      </div>
    </div>`;

  const listEl = $('#trashList', root);
  const actions = $('#trashActions', root);

  async function render() {
    const recs = await listRecordings({ deleted: true });
    actions.style.display = recs.length ? 'flex' : 'none';
    if (!recs.length) {
      listEl.innerHTML = `<div class="empty">${icons.trash}<h3>${T('trash.emptyTitle')}</h3><p>${T('trash.emptyDesc')}</p></div>`;
      return;
    }
    listEl.innerHTML = recs.map((r) => `
      <div class="row rec-row" data-id="${r.id}">
        <button class="row-play" data-act="restore" data-id="${r.id}" aria-label="${T('home.recover')}">${icons.restore}</button>
        <div class="row-main">
          <div class="row-title">${esc(r.title)}</div>
          <div class="row-sub"><span>${esc(T('trash.deletedAt', { date: fmtDate(r.deletedAt), size: fmtBytes(r.size || r.audio?.size || 0) }))}</span></div>
        </div>
        <div class="row-meta">
          <span class="row-dur">${fmtDur(r.durationMs)}</span>
          <button class="row-date" data-act="purge" data-id="${r.id}" style="color:var(--red);font-size:11px">${T('trash.purge')}</button>
        </div>
      </div>`).join('');
  }

  root.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'back') { ctx.navigate('#/settings'); return; }
    if (act === 'restore') {
      await restoreRecording(e.target.closest('[data-id]').dataset.id);
      toast(T('trash.restored'));
      await render();
      return;
    }
    if (act === 'restore-all') {
      const recs = await listRecordings({ deleted: true });
      for (const r of recs) await restoreRecording(r.id);
      toast(T('trash.restoredN', { n: recs.length }));
      await render();
      return;
    }
    if (act === 'purge') {
      const id = e.target.closest('[data-id]').dataset.id;
      const ok = await confirmDialog({ title: T('trash.purgeTitle'), message: T('trash.purgeMsg'), confirmText: T('common.delete'), danger: true });
      if (ok) { await purgeRecording(id); toast(T('trash.purged')); await render(); }
      return;
    }
    if (act === 'empty') {
      const recs = await listRecordings({ deleted: true });
      if (!recs.length) { toast(T('trash.emptyEmpty')); return; }
      const ok = await confirmDialog({ title: T('trash.emptyTitle2'), message: T('trash.emptyMsg', { n: recs.length }), confirmText: T('trash.emptyBtn'), danger: true });
      if (ok) {
        for (const r of recs) await purgeRecording(r.id);
        toast(T('trash.emptied'));
        await render();
      }
    }
  });

  render();
  return { refresh: render, destroy() {} };
}
