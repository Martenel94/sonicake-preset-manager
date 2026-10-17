/**
 * External MIDI Controller Modal
 * Configure wireless / USB MIDI foot controllers (Chocolate MIDI, Airstep, ...):
 * enable, channel, Program Change behaviour, Control Change mapping with MIDI learn,
 * and a live monitor of incoming messages.
 */

import { externalMidi, CC_ACTIONS } from '../core/external-midi.js';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

export class ExternalMidiModal {
  constructor(overlayElement) {
    this.overlay = overlayElement;

    // Re-render the whole modal on config/status changes, only the monitor on traffic.
    externalMidi.on('change', () => { if (this.isOpen()) this.render(); });
    externalMidi.on('activity', () => { if (this.isOpen()) this.renderMonitor(); });

    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close();
    });

    this.render();
  }

  isOpen() {
    return this.overlay.classList.contains('active');
  }

  open() {
    this.render();
    this.overlay.classList.add('active');
  }

  close() {
    externalMidi.cancelLearn();
    this.overlay.classList.remove('active');
  }

  statusBadge() {
    const { status, statusDetail, config } = externalMidi;
    const inputs = externalMidi.getInputNames();

    if (status === 'unsupported') {
      return { tone: 'rose', text: statusDetail || 'Web MIDI non supportata.' };
    }
    if (status === 'denied') {
      return { tone: 'amber', text: statusDetail || 'Accesso MIDI negato.' };
    }
    if (status === 'ready') {
      return inputs.length > 0
        ? { tone: 'emerald', text: `Attivo - ${inputs.length} controller: ${inputs.map(escapeHtml).join(', ')}` }
        : { tone: 'amber', text: 'Attivo, ma nessun controller MIDI rilevato. Accendi o collega il controller.' };
    }
    return { tone: 'zinc', text: config.enabled ? 'In attesa di attivazione...' : 'Disattivato' };
  }

  render() {
    const { config, learnTarget } = externalMidi;
    const badge = this.statusBadge();
    const isOn = externalMidi.status === 'ready';

    const toneClasses = {
      emerald: 'bg-emerald-950/30 border-emerald-800/40 text-emerald-300',
      amber: 'bg-amber-950/20 border-amber-800/40 text-amber-300',
      rose: 'bg-rose-950/20 border-rose-800/40 text-rose-300',
      zinc: 'bg-zinc-950/60 border-zinc-800 text-zinc-400'
    }[badge.tone];

    const channelOptions = ['<option value="0">Omni (tutti i canali)</option>']
      .concat(Array.from({ length: 16 }, (_, i) => `<option value="${i + 1}">Canale ${i + 1}</option>`))
      .join('');

    const actionRows = CC_ACTIONS.map(action => {
      const ccs = externalMidi.getCcsForAction(action.id);
      const learning = learnTarget === action.id;
      const chips = ccs.length
        ? ccs.map(cc => `
            <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-zinc-800 border border-zinc-700 text-[11px] font-mono text-cyan-300">
              CC ${cc}
              <button data-remove-cc="${cc}" class="text-zinc-400 hover:text-rose-400 leading-none" title="Rimuovi CC ${cc}" aria-label="Rimuovi CC ${cc}">&times;</button>
            </span>`).join('')
        : '<span class="text-[11px] text-zinc-400">nessun tasto assegnato</span>';

      return `
        <div class="px-3 py-2.5 flex items-center justify-between gap-3">
          <div class="min-w-0">
            <div class="text-xs font-semibold text-zinc-200">${escapeHtml(action.label)}</div>
            <div class="mt-1 flex flex-wrap gap-1.5 items-center">${chips}</div>
          </div>
          <button data-learn="${action.id}" class="shrink-0 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold transition-colors ${
            learning
              ? 'bg-amber-500 text-zinc-950 animate-pulse'
              : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-200'
          }" ${isOn ? '' : 'disabled style="opacity:.4;cursor:not-allowed"'}>
            ${learning ? 'Premi un tasto...' : 'Impara'}
          </button>
        </div>`;
    }).join('');

    this.overlay.innerHTML = `
      <div class="w-full max-w-2xl bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[88vh] animate-in fade-in zoom-in-95 duration-150">
        <!-- Header -->
        <div class="px-5 py-4 border-b border-zinc-800/80 bg-zinc-950/80 flex items-center justify-between gap-3 shrink-0">
          <div class="flex items-center gap-2.5">
            <div class="w-8 h-8 rounded-lg bg-violet-500/10 border border-violet-500/30 flex items-center justify-center text-violet-400">
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><circle cx="8" cy="10" r="1"/><circle cx="12" cy="7.5" r="1"/><circle cx="16" cy="10" r="1"/><circle cx="9.5" cy="15" r="1"/><circle cx="14.5" cy="15" r="1"/></svg>
            </div>
            <div>
              <h3 class="text-sm font-bold tracking-tight text-white uppercase">Controller MIDI Esterno</h3>
              <p class="text-[11px] text-zinc-400">Cambia brano e preset con un pedale MIDI wireless o USB</p>
            </div>
          </div>
          <button class="modal-close-btn p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors" aria-label="Chiudi">
            <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        <!-- Body -->
        <div class="p-5 overflow-y-auto space-y-5 text-sm">
          <!-- Activation -->
          <div class="space-y-2">
            <div class="flex items-center justify-between gap-3">
              <h4 class="text-xs font-bold text-violet-400 uppercase tracking-wider">Attivazione</h4>
              <button id="extMidiToggle" class="px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                isOn ? 'bg-zinc-800 hover:bg-zinc-700 text-zinc-200' : 'bg-violet-600 hover:bg-violet-500 text-white'
              }">${isOn ? 'Disattiva' : 'Attiva ascolto MIDI'}</button>
            </div>
            <div class="px-3 py-2 rounded-lg border text-xs leading-relaxed ${toneClasses}">${badge.text}</div>
            <p class="text-[11px] text-zinc-400 leading-relaxed">
              Il controller deve comparire come dispositivo MIDI del sistema (USB o Bluetooth MIDI accoppiato dal sistema operativo).
              La porta della Smart Box viene esclusa automaticamente. Non serve alcun permesso SysEx.
            </p>
          </div>

          <!-- Channel & PC mode -->
          <div class="space-y-3">
            <h4 class="text-xs font-bold text-violet-400 uppercase tracking-wider">Canale e Program Change</h4>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label class="block">
                <span class="text-[11px] text-zinc-400">Canale MIDI in ascolto</span>
                <select id="extMidiChannel" class="mt-1 w-full bg-zinc-950 border border-zinc-700 rounded-lg px-2.5 py-2 text-xs text-zinc-200">${channelOptions}</select>
              </label>
              <label class="block">
                <span class="text-[11px] text-zinc-400">Un Program Change (PC) seleziona...</span>
                <select id="extMidiPcMode" class="mt-1 w-full bg-zinc-950 border border-zinc-700 rounded-lg px-2.5 py-2 text-xs text-zinc-200">
                  <option value="setlist">Un brano della scaletta attiva</option>
                  <option value="preset">Un preset della pedaliera</option>
                </select>
              </label>
            </div>
            <p class="text-[11px] text-zinc-400 leading-relaxed">
              ${config.pcMode === 'setlist'
                ? 'PC 0 = brano 1, PC 1 = brano 2, ... Il preset collegato al brano viene caricato sulla pedaliera.'
                : 'PC 0 = preset U01, PC 49 = U50, PC 50 = F01, ... PC 99 = F50.'}
            </p>
          </div>

          <!-- CC mapping -->
          <div class="space-y-2">
            <h4 class="text-xs font-bold text-violet-400 uppercase tracking-wider">Tasti Control Change (CC)</h4>
            <div class="bg-zinc-950/60 border border-zinc-800 rounded-xl overflow-hidden divide-y divide-zinc-800/80">${actionRows}</div>
            <p class="text-[11px] text-zinc-400 leading-relaxed">
              Premi <b>Impara</b> e poi il tasto del controller: il suo numero CC viene assegnato all'azione.
              L'azione scatta una sola volta alla pressione (valore &ge; 64).
            </p>
          </div>

          <!-- Monitor -->
          <div class="space-y-2">
            <h4 class="text-xs font-bold text-violet-400 uppercase tracking-wider">Monitor messaggi</h4>
            <div id="extMidiMonitor" class="bg-zinc-950 border border-zinc-800 rounded-xl p-2 font-mono text-[11px] min-h-[64px] max-h-40 overflow-y-auto"></div>
          </div>
        </div>

        <!-- Footer -->
        <div class="px-5 py-3 border-t border-zinc-800/80 bg-zinc-950/60 flex items-center justify-between gap-3 shrink-0">
          <button id="extMidiReset" class="px-3 py-2 rounded-lg text-xs text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors">Ripristina predefiniti</button>
          <button class="modal-close-btn-bottom px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 hover:text-white text-xs font-semibold transition-colors">Chiudi</button>
        </div>
      </div>
    `;

    this.bindEvents();
    this.renderMonitor();
  }

  renderMonitor() {
    const el = this.overlay.querySelector('#extMidiMonitor');
    if (!el) return;

    if (externalMidi.activity.length === 0) {
      el.innerHTML = '<div class="px-1 py-2 text-zinc-400">In attesa di messaggi dal controller...</div>';
      return;
    }

    el.innerHTML = externalMidi.activity.map(a => {
      const time = a.time.toTimeString().split(' ')[0];
      const value = a.value !== undefined ? ` = ${a.value}` : '';
      return `
        <div class="px-1 py-0.5 flex gap-2 text-zinc-400">
          <span class="text-zinc-400">${time}</span>
          <span class="text-cyan-400 shrink-0">${a.kind} ${a.number}${value}</span>
          <span class="text-zinc-400 shrink-0">ch ${a.channel}</span>
          <span class="truncate text-zinc-300">${escapeHtml(a.result)}</span>
          <span class="truncate text-zinc-400 hidden sm:inline">${escapeHtml(a.device)}</span>
        </div>`;
    }).join('');
  }

  bindEvents() {
    this.overlay.querySelectorAll('.modal-close-btn, .modal-close-btn-bottom').forEach(btn => {
      btn.addEventListener('click', () => this.close());
    });

    this.overlay.querySelector('#extMidiToggle')?.addEventListener('click', async () => {
      if (externalMidi.status === 'ready') externalMidi.disable();
      else await externalMidi.enable();
    });

    const channel = this.overlay.querySelector('#extMidiChannel');
    if (channel) {
      channel.value = String(externalMidi.config.channel);
      channel.addEventListener('change', () => externalMidi.setChannel(channel.value));
    }

    const pcMode = this.overlay.querySelector('#extMidiPcMode');
    if (pcMode) {
      pcMode.value = externalMidi.config.pcMode;
      pcMode.addEventListener('change', () => externalMidi.setPcMode(pcMode.value));
    }

    this.overlay.querySelectorAll('[data-learn]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-learn');
        if (externalMidi.learnTarget === id) externalMidi.cancelLearn();
        else externalMidi.startLearn(id);
      });
    });

    this.overlay.querySelectorAll('[data-remove-cc]').forEach(btn => {
      btn.addEventListener('click', () => externalMidi.removeCc(btn.getAttribute('data-remove-cc')));
    });

    this.overlay.querySelector('#extMidiReset')?.addEventListener('click', () => externalMidi.resetDefaults());
  }
}
