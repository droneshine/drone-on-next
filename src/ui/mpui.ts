import * as THREE from 'three';
import type { Game } from '../game/game';
import { Multiplayer, makeCode } from '../net/multiplayer';
import type { Standing } from '../net/multiplayer';
import { getLS, setLS } from '../game/store';
import { audio } from '../audio/audio';

// Lobby, in flight squad HUD, name tags, chat, race countdown and the winner moment.

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const el = (html: string) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild as HTMLElement; };
const FEED_FOR = 14;            // seconds a feed line stays up

export function roomFromHash(): string | null {
  const m = location.hash.match(/room=([A-Za-z0-9]{4,8})/);
  return m ? m[1].toUpperCase() : null;
}

/** set or drop room= in the hash and keep everything else (debug, map links) */
function setRoomHash(code: string | null) {
  const parts = location.hash.replace(/^#/, '').split('&').filter(p => p && !p.startsWith('room='));
  if (code) parts.push(`room=${code}`);
  const h = parts.join('&');
  history.replaceState(null, '', h ? `#${h}` : location.pathname + location.search);
}

export class SquadUI {
  hud: HTMLElement;
  tags = new Map<string, HTMLElement>();
  private chatForm: HTMLFormElement;
  private chatInput: HTMLInputElement;
  private big: HTMLElement;
  private lastCount = -1;
  private lobbyBody: HTMLElement | null = null;

  constructor(private g: Game, private root: HTMLElement, private toast: (t: string) => void, private onEnterFlight: () => void) {
    this.hud = el(`
      <div class="squad">
        <div class="squad-box">
          <div class="squad-head"><b class="num code"></b><span class="cnt"></span><button class="chat-btn live" type="button" aria-label="Chat"><i class="ph ph-chat-circle"></i></button></div>
          <ol class="standings"></ol>
          <div class="feed" aria-live="polite"></div>
        </div>
        <div class="big-count num"></div>
        <form class="chat live" hidden><input type="text" maxlength="120" placeholder="Say something to the squad" aria-label="Chat message" enterkeyhint="send" autocomplete="off" /></form>
      </div>`);
    root.append(this.hud);
    this.chatForm = this.hud.querySelector('form')!;
    this.chatInput = this.hud.querySelector('input')!;
    this.big = this.hud.querySelector('.big-count')!;
    this.chatForm.addEventListener('submit', e => {
      e.preventDefault();
      this.g.mp?.chat(this.chatInput.value);
      this.chatInput.value = '';
      this.closeChat();
    });
    this.chatInput.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); this.chatInput.value = ''; this.closeChat(); }
    });
    this.chatInput.addEventListener('blur', () => { if (!this.chatForm.hidden) this.closeChat(); });
    this.hud.querySelector('.chat-btn')!.addEventListener('click', () => this.openChat());
    addEventListener('keydown', e => {
      const g = this.g;
      if (!g.mp || g.paused || !(g.state === 'fly' || g.state === 'build')) return;
      if ((e.target as HTMLElement)?.closest?.('input,textarea,select')) return;
      // T is the tree in build mode, so there only Enter opens chat
      if ((e.code === 'KeyT' && g.state === 'fly') || e.code === 'Enter') { e.preventDefault(); this.openChat(); }
      if (e.code === 'KeyG' && g.state === 'fly') g.mp.startRace();
    });
    // an invite link pasted into a running tab opens the lobby
    addEventListener('hashchange', () => {
      const code = roomFromHash();
      if (code && code !== this.g.mp?.code) { this.g.enterMenu().then(() => (window as unknown as { droneon?: { ui?: { openSheet(id: string): void } } }).droneon?.ui?.openSheet('squad')); }
    });
  }

  private openChat() {
    if (!this.g.mp || this.g.paused) return;
    this.chatForm.hidden = false; this.g.input.enabled = false;
    this.chatInput.focus();
  }
  private closeChat() {
    this.chatForm.hidden = true; this.g.input.enabled = true;
    if (document.activeElement === this.chatInput) this.chatInput.blur();
  }

  /** lobby sheet body */
  renderLobby(body: HTMLElement) {
    this.lobbyBody = body;
    const name = getLS<string>('pilotName', '');
    const hashCode = roomFromHash();
    const mp = this.g.mp;
    body.innerHTML = `
      <p class="note">Fly in the same Spielwiese with friends. Every pilot sees every drone live, you can bump into each other, build the course together and race it. No account, no server, just a room code.</p>
      <div class="fields" style="margin-top:18px">
        <div class="field wide"><label for="mp-name">Your pilot name</label><input id="mp-name" type="text" maxlength="18" value="${esc(name)}" placeholder="Pilot" autocomplete="nickname" /></div>
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
        <form class="join-row" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
          <div class="field" style="flex:0 1 200px"><label for="mp-code">Room code</label><input id="mp-code" type="text" maxlength="8" value="${esc(hashCode ?? '')}" placeholder="ABCD" style="text-transform:uppercase;font-family:var(--display);letter-spacing:0.1em" autocomplete="off" autocapitalize="characters" enterkeyhint="go" /></div>
          <button class="btn line" data-mp="join" type="submit"><i class="ph ph-sign-in"></i>Join</button>
        </form>`}
      <h3 class="group-h">In the room</h3>
      <div class="keys">
        <kbd>G</kbd><span>Host starts a race on the shared course, everyone in the air lines up for the countdown</span>
        <kbd>T</kbd><span>Chat, or Enter. On touch, the chat bubble next to the room code</span>
        <kbd>Build</kbd><span>Rings and gates you place appear for everyone</span>
      </div>`;
    const nameEl = body.querySelector<HTMLInputElement>('#mp-name')!;
    const pilotName = () => nameEl.value.replace(/\s+/g, ' ').trim().slice(0, 18) || 'Pilot ' + Math.floor(Math.random() * 900 + 100);
    nameEl.onchange = () => {
      const nm = pilotName(); setLS('pilotName', nm);
      if (this.g.mp && nm !== this.g.mp.name) { this.g.mp.rename(nm); this.toast(`You are ${nm}`); }
    };
    const joinForm = body.querySelector<HTMLFormElement>('.join-row');
    if (joinForm) joinForm.onsubmit = async e => {
      e.preventDefault();
      const code = (body.querySelector('#mp-code') as HTMLInputElement).value.trim().toUpperCase();
      if (!/^[A-Z0-9]{4,8}$/.test(code)) { this.toast('Enter the four letter room code'); return; }
      audio.start(); audio.tick();
      const nm = pilotName(); setLS('pilotName', nm);
      await this.join(code, nm, false);
    };
    body.onclick = async (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-mp]');
      if (!b || b.dataset.mp === 'join') return;
      audio.start(); audio.tick();
      const nm = pilotName();
      setLS('pilotName', nm);
      const act = b.dataset.mp;
      if (act === 'create') await this.join(makeCode(), nm, true);
      if (act === 'invite') this.copyInvite();
      if (act === 'leave') { await this.leave(); this.renderLobby(body); }
      if (act === 'fly') this.onEnterFlight();
    };
  }

  async join(code: string, name: string, created: boolean) {
    if (this.g.mp) await this.leave(true);
    const mp = new Multiplayer(this.g, code, name);
    this.g.mp = mp;
    mp.on((ev, data) => this.onEvent(ev, data));
    setRoomHash(mp.code);
    this.onEnterFlight();
    // the creator gets the link on the clipboard, a joiner keeps theirs
    if (created) await this.copyInvite(true);
    else this.toast(`Joining room ${mp.code}`);
  }

  async leave(quiet = false) {
    const mp = this.g.mp;
    if (!mp) return;
    this.g.mp = null;
    this.closeChat();
    await mp.leave();
    for (const t of this.tags.values()) t.remove();
    this.tags.clear();
    setRoomHash(null);
    if (!quiet) this.toast('Left the room');
  }

  async copyInvite(created = false) {
    const mp = this.g.mp; if (!mp) return;
    const url = `${location.origin}${location.pathname}#room=${mp.code}`;
    try { await navigator.clipboard.writeText(url); this.toast(created ? `Room ${mp.code}. Invite link copied, send it to your squad` : 'Invite link copied'); }
    catch {
      if (created) this.toast(`Room ${mp.code}. Share the code or the link from the pause menu`);
      else prompt('Send this link', url);
    }
  }

  private onEvent(ev: string, data?: unknown) {
    const mp = this.g.mp; if (!mp) return;
    if (ev === 'winner') {
      const w = data as Standing;
      this.flash(w.self ? 'WINNER' : `${w.name.toUpperCase()} WINS`, w.self ? 'You took it' : `${(w.finished ?? 0).toFixed(2)} s`);
      if (w.self) audio.success();
    }
    if (ev === 'race' && mp.raceState === 'done') {
      const st = mp.standings().filter(s => mp.grid.has(s.id) || s.finished != null || s.dnf);
      if (st.length) this.toast(st.map((s, i) => `${i + 1}. ${s.name} ${s.finished != null ? s.finished.toFixed(2) + ' s' : 'DNF'}`).join('   '));
    }
    if ((ev === 'pilots' || ev === 'race') && this.lobbyBody?.isConnected && this.lobbyBody.closest('.sheet.open') && !this.lobbyBody.contains(document.activeElement)) this.renderLobby(this.lobbyBody);
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
    this.hud.classList.toggle('building', this.g.state === 'build');
    if (!mp) { for (const t of this.tags.values()) t.hidden = true; return; }
    if (this.g.paused && !this.chatForm.hidden) this.closeChat();
    (this.hud.querySelector('.code') as HTMLElement).textContent = mp.code;
    const n = mp.pilots.size + 1;
    (this.hud.querySelector('.cnt') as HTMLElement).textContent = `${n} pilot${n > 1 ? 's' : ''}${mp.isHost() ? ', host' : ''}`;
    // standings: in a race by position, otherwise just the squad
    const st = mp.standings();
    const cps = this.g.raceCount || 0;
    const racing = mp.raceState !== 'idle';
    const cell = (s: Standing) => {
      if (!racing) return '';
      if (!mp.grid.has(s.id)) return 'watching';
      if (s.finished != null) return s.finished.toFixed(2);
      if (s.dnf) return 'DNF';
      return `${Math.min(cps, s.idx)}/${cps}`;
    };
    const html = st.map(s => `<li class="${s.self ? 'me' : ''}"><i style="background:${esc(s.color)}"></i><span>${esc(s.name)}</span><b class="num">${cell(s)}</b></li>`).join('');
    const ol = this.hud.querySelector('.standings') as HTMLElement;
    if (ol.innerHTML !== html) ol.innerHTML = html;
    const feed = this.hud.querySelector('.feed') as HTMLElement;
    const fh = mp.feed.filter(f => mp.clock - f.t < FEED_FOR).slice(-4).map(f => `<div>${esc(f.text)}</div>`).join('');
    if (feed.innerHTML !== fh) feed.innerHTML = fh;
    // countdown, only for pilots on the grid
    const mine = mp.grid.has(mp.selfId);
    if (mp.raceState === 'countdown' && mine) {
      const left = Math.ceil(mp.countdownEnd - mp.clock);
      if (left !== this.lastCount) { this.lastCount = left; this.big.textContent = left > 3 ? 'GET READY' : String(Math.max(1, left)); this.big.classList.add('on'); if (left <= 3) audio.tick(); }
    } else if (mp.raceState === 'running' && mine && this.lastCount !== 0 && this.lastCount !== -2) {
      this.lastCount = 0; this.big.textContent = 'GO'; setTimeout(() => { this.big.classList.remove('on'); this.lastCount = -2; }, 900);
    } else if (mp.raceState === 'idle' || !mine) { this.big.classList.remove('on'); this.lastCount = -1; }
    // name tags
    for (const p of mp.pilots.values()) {
      let tag = this.tags.get(p.id);
      if (!tag) { tag = el(`<div class="nametag"><b></b><span></span></div>`); this.root.append(tag); this.tags.set(p.id, tag); }
      const vis = !!p.visual?.root.visible && this.g.state !== 'menu';
      const pr = this.g.project(p.pos.clone().add(new THREE.Vector3(0, p.spec.armLength + 0.6, 0)));
      const dist = this.g.camera.position.distanceTo(p.pos);
      tag.hidden = !vis || pr.behind || dist > 400;
      if (!tag.hidden) {
        tag.style.transform = `translate(${pr.x}px, ${pr.y}px) translate(-50%, -100%)`;
        const b = tag.querySelector('b') as HTMLElement;
        if (b.textContent !== p.name) b.textContent = p.name;
        b.style.color = mp.colorOf(p.id);
        (tag.querySelector('span') as HTMLElement).textContent = p.crashed ? 'crashed' : `${p.spec.name}  ${dist.toFixed(0)} m`;
      }
    }
    for (const [id, t] of this.tags) if (!mp.pilots.has(id)) { t.remove(); this.tags.delete(id); }
  }
}
