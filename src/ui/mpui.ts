import * as THREE from 'three';
import type { Game } from '../game/game';
import { Multiplayer, makeCode } from '../net/multiplayer';
import { getLS, setLS } from '../game/store';
import { audio } from '../audio/audio';

// Lobby, in flight squad HUD, name tags, chat, race countdown and the winner moment.

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const el = (html: string) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild as HTMLElement; };

export function roomFromHash(): string | null {
  const m = location.hash.match(/room=([A-Za-z0-9]{4,8})/);
  return m ? m[1].toUpperCase() : null;
}

export class SquadUI {
  hud: HTMLElement;
  tags = new Map<string, HTMLElement>();
  private chatInput: HTMLInputElement;
  private big: HTMLElement;
  private lastCount = -1;

  constructor(private g: Game, private root: HTMLElement, private toast: (t: string) => void, private onEnterFlight: () => void) {
    this.hud = el(`
      <div class="squad">
        <div class="squad-box">
          <div class="squad-head"><b class="num code"></b><span class="cnt"></span></div>
          <ol class="standings"></ol>
          <div class="feed"></div>
        </div>
        <div class="big-count num"></div>
        <form class="chat live" hidden><input type="text" maxlength="120" placeholder="Say something to the squad" aria-label="Chat message" /></form>
      </div>`);
    root.append(this.hud);
    this.chatInput = this.hud.querySelector('input')!;
    this.big = this.hud.querySelector('.big-count')!;
    this.hud.querySelector('form')!.addEventListener('submit', e => {
      e.preventDefault();
      this.g.mp?.chat(this.chatInput.value);
      this.chatInput.value = '';
      this.closeChat();
    });
    this.chatInput.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); this.closeChat(); } });
    addEventListener('keydown', e => {
      if (!this.g.mp || !(this.g.state === 'fly' || this.g.state === 'build')) return;
      if ((e.target as HTMLElement)?.closest?.('input,textarea')) return;
      if (e.code === 'KeyT' || e.code === 'Enter') { e.preventDefault(); this.openChat(); }
      if (e.code === 'KeyG' && this.g.state === 'fly') this.g.mp.startRace();
    });
  }

  private openChat() { const f = this.hud.querySelector('form')!; f.hidden = false; this.g.input.enabled = false; this.chatInput.focus(); }
  private closeChat() { this.hud.querySelector('form')!.hidden = true; this.g.input.enabled = true; this.chatInput.blur(); }

  /** lobby sheet body */
  renderLobby(body: HTMLElement) {
    const name = getLS<string>('pilotName', '');
    const hashCode = roomFromHash();
    const mp = this.g.mp;
    body.innerHTML = `
      <p class="note">Fly in the same Spielwiese with friends. Every pilot sees every drone live, you can bump into each other, build the course together and race it. No account, no server, just a room code.</p>
      <div class="fields" style="margin-top:18px">
        <div class="field wide"><label for="mp-name">Your pilot name</label><input id="mp-name" type="text" maxlength="18" value="${esc(name)}" placeholder="Luca" autocomplete="nickname" /></div>
      </div>
      ${mp ? `
        <h3 class="group-h">You are in room ${esc(mp.code)}</h3>
        <p class="note">${mp.pilots.size ? `${mp.pilots.size + 1} pilots here.` : 'Waiting for friends. Send them the link.'} ${mp.isHost() ? 'You are the host and start races with G.' : ''}</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px">
          <button class="btn go" data-mp="fly"><i class="ph-fill ph-play"></i>Back to the field</button>
          <button class="btn line" data-mp="invite"><i class="ph ph-link"></i>Copy invite link</button>
          <button class="btn quiet" data-mp="leave">Leave room</button>
        </div>` : `
        <h3 class="group-h">Start a room</h3>
        <p class="note">You get a four letter code and a link to send.</p>
        <div style="margin-top:12px"><button class="btn go" data-mp="create"><i class="ph ph-users-three"></i>Create room</button></div>
        <h3 class="group-h">Join a friend</h3>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
          <div class="field" style="flex:0 1 200px"><label for="mp-code">Room code</label><input id="mp-code" type="text" maxlength="8" value="${esc(hashCode ?? '')}" placeholder="ABCD" style="text-transform:uppercase;font-family:var(--display);letter-spacing:0.1em" autocomplete="off" /></div>
          <button class="btn line" data-mp="join"><i class="ph ph-sign-in"></i>Join</button>
        </div>`}
      <h3 class="group-h">In the room</h3>
      <div class="keys">
        <kbd>G</kbd><span>Host starts a race on the shared course, everyone lines up for the countdown</span>
        <kbd>T</kbd><span>Chat</span>
        <kbd>Build</kbd><span>Rings and gates you place appear for everyone</span>
      </div>`;
    body.onclick = async (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-mp]');
      if (!b) return;
      audio.start(); audio.tick();
      const nm = (body.querySelector('#mp-name') as HTMLInputElement).value.trim() || 'Pilot ' + Math.floor(Math.random() * 900 + 100);
      setLS('pilotName', nm);
      const act = b.dataset.mp;
      if (act === 'create') await this.join(makeCode(), nm);
      if (act === 'join') {
        const code = (body.querySelector('#mp-code') as HTMLInputElement).value.trim().toUpperCase();
        if (code.length < 4) { this.toast('Enter the four letter room code'); return; }
        await this.join(code, nm);
      }
      if (act === 'invite') this.copyInvite();
      if (act === 'leave') { await this.leave(); this.renderLobby(body); }
      if (act === 'fly') this.onEnterFlight();
    };
  }

  async join(code: string, name: string) {
    if (this.g.mp) await this.leave();
    const mp = new Multiplayer(this.g, code, name);
    this.g.mp = mp;
    mp.on((ev, data) => this.onEvent(ev, data));
    history.replaceState(null, '', `#room=${mp.code}`);
    this.toast(`Room ${mp.code}. Send the link to your squad.`);
    this.onEnterFlight();
    this.copyInvite(true);
  }

  async leave() {
    const mp = this.g.mp;
    if (!mp) return;
    this.g.mp = null;
    await mp.leave();
    for (const t of this.tags.values()) t.remove();
    this.tags.clear();
    history.replaceState(null, '', location.pathname);
    this.toast('Left the room');
  }

  async copyInvite(silent = false) {
    const mp = this.g.mp; if (!mp) return;
    const url = `${location.origin}${location.pathname}#room=${mp.code}`;
    try { await navigator.clipboard.writeText(url); if (!silent) this.toast('Invite link copied'); else this.toast(`Invite link copied. Room ${mp.code}`); }
    catch { if (!silent) prompt('Send this link', url); }
  }

  private onEvent(ev: string, data?: unknown) {
    const mp = this.g.mp; if (!mp) return;
    if (ev === 'winner') {
      const w = data as { name: string; self: boolean; finished: number };
      this.flash(w.self ? 'WINNER' : `${w.name.toUpperCase()} WINS`, w.self ? 'You took it' : `${w.finished.toFixed(2)} s`);
      if (w.self) audio.success();
    }
    if (ev === 'race' && mp.raceState === 'done') {
      const st = mp.standings();
      this.toast(st.map((s, i) => `${i + 1}. ${s.name} ${s.finished?.toFixed(2) ?? ''}`).join('   '));
    }
  }

  private flash(title: string, sub: string) {
    const f = el(`<div class="victory"><h2>${esc(title)}</h2><p>${esc(sub)}</p></div>`);
    this.root.append(f);
    requestAnimationFrame(() => f.classList.add('on'));
    setTimeout(() => { f.classList.remove('on'); setTimeout(() => f.remove(), 400); }, 3600);
  }

  /** per frame */
  frame() {
    const mp = this.g.mp;
    const show = !!mp && (this.g.state === 'fly' || this.g.state === 'build');
    this.hud.classList.toggle('on', show);
    if (!mp) { for (const t of this.tags.values()) t.hidden = true; return; }
    (this.hud.querySelector('.code') as HTMLElement).textContent = mp.code;
    const n = mp.pilots.size + 1;
    (this.hud.querySelector('.cnt') as HTMLElement).textContent = `${n} pilot${n > 1 ? 's' : ''}${mp.isHost() ? ', host' : ''}`;
    // standings: in a race by position, otherwise just the squad
    const st = mp.standings();
    const cps = this.g.raceCount || 0;
    const racing = mp.raceState !== 'idle';
    const html = st.map(s => `<li class="${s.self ? 'me' : ''}"><i style="background:${esc(s.color)}"></i><span>${esc(s.name)}</span><b class="num">${racing ? (s.finished != null ? s.finished.toFixed(2) : `${Math.min(cps, s.idx)}/${cps}`) : ''}</b></li>`).join('');
    const ol = this.hud.querySelector('.standings') as HTMLElement;
    if (ol.innerHTML !== html) ol.innerHTML = html;
    const feed = this.hud.querySelector('.feed') as HTMLElement;
    const fh = mp.feed.slice(-4).map(f => `<div>${esc(f.text)}</div>`).join('');
    if (feed.innerHTML !== fh) feed.innerHTML = fh;
    // countdown
    if (mp.raceState === 'countdown') {
      const left = Math.ceil(mp.countdownEnd - mp.clock);
      if (left !== this.lastCount) { this.lastCount = left; this.big.textContent = left > 3 ? 'GET READY' : String(Math.max(1, left)); this.big.classList.add('on'); if (left <= 3) audio.tick(); }
    } else if (mp.raceState === 'running' && this.lastCount !== 0 && this.lastCount !== -2) {
      this.lastCount = 0; this.big.textContent = 'GO'; setTimeout(() => { this.big.classList.remove('on'); this.lastCount = -2; }, 900);
    } else if (mp.raceState === 'idle') { this.big.classList.remove('on'); this.lastCount = -1; }
    // name tags
    for (const p of mp.pilots.values()) {
      let tag = this.tags.get(p.id);
      if (!tag) { tag = el(`<div class="nametag"><b></b><span></span></div>`); this.root.append(tag); this.tags.set(p.id, tag); }
      const vis = p.visual?.root.visible;
      const pr = this.g.project(p.pos.clone().add(new THREE.Vector3(0, p.spec.armLength + 0.6, 0)));
      const dist = this.g.camera.position.distanceTo(p.pos);
      tag.hidden = !vis || pr.behind || dist > 400;
      if (!tag.hidden) {
        tag.style.transform = `translate(${pr.x}px, ${pr.y}px) translate(-50%, -100%)`;
        (tag.querySelector('b') as HTMLElement).textContent = p.name;
        (tag.querySelector('b') as HTMLElement).style.color = mp.colorOf(p.id);
        (tag.querySelector('span') as HTMLElement).textContent = p.crashed ? 'crashed' : `${p.spec.name}  ${dist.toFixed(0)} m`;
      }
    }
    for (const [id, t] of this.tags) if (!mp.pilots.has(id)) { t.remove(); this.tags.delete(id); }
  }
}

