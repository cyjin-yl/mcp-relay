// @ts-nocheck
// Native web-component-source-v1: no Proto-UI Runtime/Core/Adapter dependency.
// Helper cost: owner/callback guards, scalar state + subscriptions, prop fallback/watch,
// microtask update/ViewIntent reconciliation, native shadow DOM template construction.
// Context cost: shared reference-key modules, owner scopes, checked JSON records, dynamic logical DOM ancestry.
// Context ancestry follows registered generated owners, never tag names or CSS markers.
// setProps is a full raw snapshot. No automatic state-write rendering.
// Synchronous DOM moves retain the owner; settled disconnection disposes it.
// setPresent detaches only the view; explicit dispose permanently closes this element.
import {createContextScope as __wcCreateContextScope, ownerScopes as __wcOwnerScopes, acceptsContextValue as __wcAccepts, type ContextScope as __wcContextScope} from "./.proto-ui/context/scope-v1";









import { createNativeBrowserPort, type NativeBrowserPort, type NativeFrameBuilder } from './.proto-ui/web-component/browser-v1';
type BrowserPort = NativeBrowserPort<undefined>;
type HostPort = BrowserPort;
const __wcPropTypes = {};
import {createNativeStyle as __wcCreateNativeStyle, templateStyleTokens as __wcTemplateStyleTokens, type NativeStyle as __wcStyle, type NativeStyleHandle as __wcNativeStyleHandle, type NativeRuleHandle as __wcNativeRuleHandle} from './.proto-ui/style/native-v1';


export type GeneratedProps = {

};
type __wcPropsSnapshot = {

};
export type GeneratedExposes = {

};
type __wcExternalState<T> = { get(): T; subscribe(cb: (event: {type: 'next'; prev: T; next: T; reason?: unknown}) => void): () => void; unsubscribe(off: () => void): void; spec: Readonly<__wcStateOptions & {kind: string}> };
type __wcScalar = string | number | boolean | null;
type __wcSnapshot = Readonly<Record<string, unknown>>;
type __wcPropSpec = {type: string; schema?: Parameters<typeof __wcAccepts>[0]; default?: unknown; options?: readonly string[]; empty?: 'accept' | 'fallback' | 'error'; range?: {min?: number; max?: number}};
type __wcStateOptions = {options?: readonly __wcScalar[]; min?: number; max?: number; step?: number; clamp?: boolean};
type __wcState<T extends __wcScalar = __wcScalar> = {get(): T; setDefault(next: T): void; set(next: T, reason?: unknown): void; external: __wcExternalState<T>; subscribers: Set<Function>};
type __wcContextKey<T> = object & {readonly __contextValue?: T};
type __wcContextRead = Readonly<{read<T>(key: __wcContextKey<T>): T; tryRead<T>(key: __wcContextKey<T>): T | null}>;
type __wcContextRun = __wcContextRead & {update<T>(key: __wcContextKey<T>, next: T | ((prev: T) => T)): void; tryUpdate<T>(key: __wcContextKey<T>, next: T | ((prev: T) => T)): boolean};
type __wcContextDef = {provide<T>(key: __wcContextKey<T>, value: T): void; subscribe<T>(key: __wcContextKey<T>, callback?: (run: __wcRun, next: T, prev: T) => void): () => void; trySubscribe<T>(key: __wcContextKey<T>, callback?: (run: __wcRun, next: T | null, prev: T | null) => void): () => void};

type __wcPropsRead = Readonly<{get(): __wcPropsSnapshot; getRaw(): Readonly<Record<string, unknown>>; isProvided(key: string): boolean}>;
type __wcRun = {host: {get(): HTMLElement | null}; readonly feedback: {readonly style: __wcStyle}; readonly context: __wcContextRun; update(): void; props: __wcPropsRead; lifecycle: {setPresent(next: boolean): void}; expose: {emit(key: string, payload?: unknown, options?: CustomEventInit): void}};
type __wcRenderer = { slot(): (()=>Node); readonly nativeFrame:NativeFrameBuilder; readonly props: __wcPropsRead; readonly read: Readonly<{readonly props: __wcPropsRead; readonly context: __wcContextRead}>};
type __wcDef = {
  readonly feedback: {readonly style: __wcStyle};


  context: __wcContextDef;
  props: {define(input: Record<string, __wcPropSpec>): void; setDefaults(input: Record<string, unknown>): void; watch(keys: string[], fn: Function): () => void; watchAll(fn: Function): () => void; watchRaw(keys: string[], fn: Function): () => void; watchRawAll(fn: Function): () => void};
  state: {bool(s: string, v: boolean): __wcState<boolean>; enum(s: string, v: string, o: __wcStateOptions): __wcState<string>; string(s: string, v: string, o?: __wcStateOptions): __wcState<string>; numberDiscrete(s: string, v: number, o?: __wcStateOptions): __wcState<number>; numberRange(s: string, v: number, o: __wcStateOptions): __wcState<number>};
  expose: {value(key: string, value: unknown): void; state(key: string, handle: __wcState): void; method<A extends unknown[], R>(key: string, fn: (...args: A) => R, project?: (value: R) => R): void; event(key: string, spec?: object): void};
  lifecycle: {onCreated(fn: Function): void; onMounted(fn: Function): void; onUpdated(fn: Function): void; onUnmounted(fn: Function): void; onBeforeDispose(fn: Function): void};
};
type __wcOwner = {identity: symbol; def: __wcDef; exposes: Record<string, unknown>; render?: Function | void; readonly epoch: number; readonly view: boolean; readonly style: __wcStyle; props(): __wcPropsSnapshot; hydrate(input: Record<string, unknown>): void; update(): void; reconcile(): void; created(): void; dispose(): void};
function __wcCreateOwner(host: HostPort): __wcOwner {
  let alive = true, disposing = false, setup = true, callbackDepth = 0;

  let intent = true, view = false, epoch = 0, queued = false, dirty = false, hostScheduled = false;

  let propsWindow: {raw: Readonly<Record<string, unknown>>; resolved: __wcSnapshot} | null = null;
  let resolved: __wcSnapshot = Object.freeze({}), raw: Readonly<Record<string, unknown>> = Object.freeze({}), hydrated = false;
  const specs: Record<string, __wcPropSpec> = Object.create(null), previous: Record<string, unknown> = Object.create(null), defaults: Record<string, unknown>[] = [];
  const watchers: {keys: string[] | null; fn: Function; active: boolean; raw: boolean}[] = [], states: __wcState[] = [], emissions: (() => void)[] = [];
  let emitting = false;
  const exposes: Record<string, unknown> = Object.create(null), events = new Set<string>();
  const lifecycle: Record<string, Function[]> = {created: [], mounted: [], updated: [], unmounted: [], beforeDispose: []};
  const own = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key);
  const ensure = () => { if (!alive) throw new Error('Logical owner is disposed'); };
  const ensureExternal = () => { ensure(); if (disposing) throw new Error('Logical owner is disposing'); };
  const ensureSetup = () => { ensure(); if (!setup) throw new Error('Setup capability is closed'); };
  const runtime = () => { ensure(); if (setup || !callbackDepth) throw new Error('State writes require a live callback scope'); };
  

  const context = __wcCreateContextScope({getParent: () => host.parentContext(), isAlive: () => alive,
    invoke: <T>(callback: () => T): T => invoke(callback, [], false) as T, validate: (key: object, value: unknown): boolean => false});

  const __wcStyle = __wcCreateNativeStyle({ensureSetup, ensureRuntime: runtime, isAlive: () => alive,
    project(tokens) { host.attribute('data-pui-style', tokens.length ? tokens.join(' ') : null); }});


  
  function invoke(fn: Function, args: unknown[] = [], withRun = true): unknown {
    ensure();
    const check = () => runtime();
    const run: __wcRun = {
      host: { get() { check(); return view && !disposing ? host.root : null; } },
      feedback: {style: __wcStyle},

      context: Object.freeze({
        read<T>(key: __wcContextKey<T>): T { check(); return context.read(key) as T; },
        tryRead<T>(key: __wcContextKey<T>): T | null { check(); return context.tryRead(key) as T | null; },
        update<T>(key: __wcContextKey<T>, next: T | ((prev: T) => T)) { check(); runtime(); context.update(key, next); },
        tryUpdate<T>(key: __wcContextKey<T>, next: T | ((prev: T) => T)) { check(); runtime(); return context.tryUpdate(key, next); },
      }),
      update() { check(); if (!disposing) schedule(true); },
      props: Object.freeze({get() { check(); return (propsWindow?.resolved ?? resolved) as __wcPropsSnapshot; }, getRaw() { check(); return propsWindow?.raw ?? raw; }, isProvided(key: string) { check(); return own(propsWindow?.raw ?? raw, key); }}),
      lifecycle: {setPresent(next: boolean) { check(); if (disposing) return; intent = next; schedule(false); }},
      expose: {emit(key: string, payload?: unknown, options?: CustomEventInit) { check(); if (!events.has(key)) throw new Error('Undeclared exposed event: ' + key); host.emit(key, payload, options); }},
    };

    ++callbackDepth;
    try { return fn(...(withRun ? [run, ...args] : args)); }
    finally { --callbackDepth; }
  }
  __wcOwnerScopes.set(host, context);
  host.bindContext(context);

  const contextRead: __wcContextRead = Object.freeze({
    read<T>(key: __wcContextKey<T>): T { ensure(); if (setup) throw new Error('Context reads require runtime scope'); return context.read(key) as T; },
    tryRead<T>(key: __wcContextKey<T>): T | null { ensure(); if (setup) throw new Error('Context reads require runtime scope'); return context.tryRead(key) as T | null; },
  });
  function fire(name: string): void {
    if (name === 'unmounted') {  }
    let error: unknown;
    try { for (const fn of lifecycle[name]) { try { invoke(fn); } catch (caught) { error ??= caught; } } }
    finally { if (name === 'unmounted') {  } }
    if (error !== undefined) throw error;
  }
  function valid(spec: __wcPropSpec, value: unknown): boolean {
    if (spec.schema === undefined) throw new Error('Missing checked Props schema');
    return __wcAccepts(spec.schema, value) && (!spec.options || spec.options.includes(value as string)) &&
      (!spec.range || (typeof value === 'number' && value >= (spec.range.min ?? -Infinity) && value <= (spec.range.max ?? Infinity)));
  }
  function resolve(strict: boolean): __wcSnapshot {
    const next: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(specs)) {
      const spec = specs[key], provided = own(raw, key), value = raw[key];
      const requireValue = strict && spec.empty === 'error';
      if (provided && value != null && valid(spec, value)) { next[key] = value; previous[key] = value; continue; }
      if (provided && value == null && spec.empty === 'accept') { next[key] = null; continue; }
      let candidate: unknown;
      if (provided && own(previous, key) && valid(spec, previous[key])) candidate = previous[key];
      if (candidate === undefined) for (const layer of defaults) {
        if (!own(layer, key)) continue;
        const value = layer[key];
        if ((value === null && !requireValue) || (value != null && valid(spec, value))) { candidate = value; break; }
      }
      if (candidate === undefined && own(spec, 'default')) {
        const value = spec.default;
        if ((value === null && !requireValue) || (value != null && valid(spec, value))) candidate = value;
      }
      if (candidate === undefined) {
        if (requireValue) throw new Error('Prop has no valid fallback: ' + key);
        candidate = null;
      }
      next[key] = candidate;
      if (provided && next[key] != null) previous[key] = next[key];
    }
    return Object.freeze(next);
  }
  function hydrate(input: Record<string, unknown>): void {
    ensure();
    const prev = resolved, previousRaw = raw;
    raw = Object.freeze({...input});
    resolved = resolve(true);
    __wcStyle.refresh();


    if (!hydrated) { hydrated = true; return; }
    const changed = Object.keys(specs).filter((key) => !Object.is(prev[key], resolved[key]));
    const rawChanged = watchers.some((watcher) => watcher.raw && watcher.active) ? [...new Set([...Object.keys(previousRaw), ...Object.keys(raw)])].filter((key) => own(previousRaw, key) !== own(raw, key) || !Object.is(previousRaw[key], raw[key])) : changed;
    const next = resolved, nextRaw = raw;
    const previousWindow = propsWindow; propsWindow = {raw: nextRaw, resolved: next};
    try { for (const watcher of [...watchers]) {
      const all = watcher.raw ? rawChanged : changed;
      const matched = watcher.keys === null ? all : all.filter((key) => watcher.keys!.includes(key));
      if (watcher.active && matched.length) invoke(watcher.fn, [watcher.raw ? nextRaw : next, watcher.raw ? previousRaw : prev, {changedKeysAll: all, changedKeysMatched: matched}]);
    } } finally { propsWindow = previousWindow; }
  }
  function drainEmissions(): void {
    if (!emitting) {
  emitting = true;
  const notificationFailures: unknown[] = [];
  let notificationIndex = 0;
  try {
    while (notificationIndex < emissions.length && (alive && !disposing)) {
      try { emissions[notificationIndex++](); } catch (error) {
        Object.defineProperty(notificationFailures, notificationFailures.length, {value:error, writable:true, enumerable:true, configurable:true});
      }
    }
  } finally { emissions.length = 0; emitting = false; }
  if (notificationFailures.length === 1) throw notificationFailures[0];
  if (notificationFailures.length > 1) throw new AggregateError(notificationFailures, '[State] subscriber failures');
}
  }
  function state<T extends __wcScalar>(kind: string, semantic: string, initial: T, options: __wcStateOptions = {}): __wcState<T> {
    ensureSetup();

    if (typeof semantic !== 'string' || semantic.length === 0) throw new Error('Invalid state semantic');
    const spec = Object.freeze({...options, kind});
    function validate(value: unknown): void {
      const type = kind === 'bool' ? 'boolean' : kind === 'string' || kind === 'enum' ? 'string' : 'number';
      if (typeof value !== type || (type === 'number' && Number.isNaN(value))) throw new Error('Invalid state value');
      if (options.options?.length && !options.options.includes(value as __wcScalar)) throw new Error('State value outside options');
      if (kind === 'number.range' || (kind === 'number.discrete' && !options.options?.length)) {
        const numeric = typeof value === 'number' ? value : NaN;
        if (numeric < (options.min ?? -Infinity) || numeric > (options.max ?? Infinity)) throw new Error('State value outside range');
        if (kind === 'number.discrete' && options.step !== undefined && options.step > 0 && !Number.isInteger((numeric - (options.min ?? 0)) / options.step)) throw new Error('State value violates step');
      }
    }
    if (kind === 'number.range' && options.clamp) initial = Math.max(options.min ?? -Infinity, Math.min(options.max ?? Infinity, initial as number)) as T;
    validate(initial);
    let value = initial;
    const subscribers = new Set<Function>();
    const external = Object.freeze({
      get() { ensureExternal(); return value; }, spec,
      subscribe(fn: Function) { ensureExternal(); const registration = (event: unknown) => fn(event); subscribers.add(registration); return () => subscribers.delete(registration); },
      unsubscribe(off: () => void) { ensureExternal(); off(); },
    });
    const handle = {external, subscribers,
      get() { ensure(); return value; },
      setDefault(next: T) { ensureSetup(); validate(next); value = next; },
      set(next: T, reason?: unknown) {
        runtime(); validate(next); if (Object.is(value, next)) return;
        const prev = value; value = next;
        __wcStyle.refresh();


        for (const subscriber of Array.from(subscribers)) {
  Object.defineProperty(emissions, emissions.length, {value: () => { if ((alive && !disposing) && subscribers.has(subscriber)) { invoke(subscriber, [{type: 'next', prev, next, reason}], false); } }, writable:true, enumerable:true, configurable:true});
}

        drainEmissions();
      },
    };
    states.push(handle);  return handle;
  }
  let slotUsed = false;

  function render(): void {
    slotUsed = false;
    const nativeFrame=host.createFrame();
    const props: __wcPropsRead=Object.freeze({get:()=>resolved as __wcPropsSnapshot,getRaw:()=>raw,isProvided:(key:string)=>own(raw,key)});
    const renderer: __wcRenderer={nativeFrame,slot(){if(slotUsed)throw new Error('Multiple slots are unsupported');slotUsed=true;return ()=>nativeFrame.slot();},props,read:Object.freeze({props, context: contextRead})};
    projectHost();
    let fragment:DocumentFragment;
    if(typeof owner.render==='function')fragment=owner.render(renderer) as DocumentFragment;
    else {fragment=nativeFrame.document.createDocumentFragment();fragment.appendChild(renderer.slot()());}
    host.commit(nativeFrame.finish(fragment));
  }
  function projectHost(): void {
    host.projectRoot(null, {}, null);
  }
  function detach(): void {
    host.visible(false);
    if (!view) return;
    view = false; ++epoch;
    let error: unknown;
    try { __wcStyle.unmount(); host.attribute('data-pui-style', null); } catch (caught) { error ??= caught; }
    try { fire('unmounted'); } catch (caught) { error ??= caught; } finally { host.clear(); }
    if (error !== undefined) throw error;
  }
  function reconcile(): void {
    if (!alive || disposing || !host.isConnected || host.server) return;
    if (!intent) { detach(); return; }
    host.visible(true);
    if (!view) {
      ++epoch; render(); view = true; dirty = false;
      __wcStyle.mount();
      fire('mounted');
    } else if (dirty) { dirty = false; render(); fire('updated'); }
  }
  function schedule(update: boolean): void {
    ensure(); dirty ||= update;
    if (host.server || queued || disposing) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (!alive || disposing) return;
      // Detached dirty work is retained until the next actual view commit.
      if (host.isConnected) reconcile();
    });
  }

  function expose(key: string, value: unknown): void { ensureSetup(); if (own(exposes, key) || events.has(key)) throw new Error('Duplicate expose: ' + key); exposes[key] = value; }
  const def: __wcDef = {
    feedback: {style: __wcStyle},


    context: {
      provide(key, value) { ensureSetup(); context.provide(key, value); },
      subscribe(key, callback) { ensureSetup(); return context.subscribe(key, 'required', callback ? (next, prev) => { invoke(callback, [next, prev]); } : undefined); },
      trySubscribe(key, callback) { ensureSetup(); return context.subscribe(key, 'optional', callback ? (next, prev) => { invoke(callback, [next, prev]); } : undefined); },
    },
    props: {
      define(input: Record<string, __wcPropSpec>) {
        ensureSetup();
        const merged = {...specs};
        for (const key of Object.keys(input)) {
          const next = input[key], prev = specs[key];
          if (!['boolean', 'number', 'string', 'enum', 'object', 'any'].includes(next.type)) throw new Error('Unsupported prop type');
          if (next.empty !== undefined && !['accept', 'fallback', 'error'].includes(next.empty)) throw new Error('Invalid prop empty policy');
          if (next.range && ((next.range.min !== undefined && (typeof next.range.min !== 'number' || Number.isNaN(next.range.min))) || (next.range.max !== undefined && (typeof next.range.max !== 'number' || Number.isNaN(next.range.max))))) throw new Error('Invalid prop range');
          if (prev && (prev.type !== next.type || (prev.range && next.range && ((next.range.min ?? -Infinity) > (prev.range.min ?? -Infinity) || (next.range.max ?? Infinity) < (prev.range.max ?? Infinity))))) throw new Error('Conflicting prop declaration');
          const rank = (empty: string) => empty === 'accept' ? 0 : empty === 'error' ? 2 : 1;
          if (prev && next.empty !== undefined && rank(next.empty) > rank(prev.empty ?? 'fallback')) throw new Error('Conflicting prop empty policy');
          merged[key] = {...prev, ...next, schema: (__wcPropTypes as Record<string, Parameters<typeof __wcAccepts>[0]>)[key], empty: prev?.empty ?? next.empty ?? 'fallback', range: next.range ?? prev?.range, ...(prev && own(prev, 'default') ? {default: prev.default} : {})};
        }
        Object.assign(specs, merged);
        resolved = resolve(false);

      },
      setDefaults(input: Record<string, unknown>) { ensureSetup(); for (const key of Object.keys(input)) if (!own(specs, key)) throw new Error('Undeclared prop default: ' + key); defaults.unshift({...input}); resolved = resolve(false); },
      watch(keys: string[], fn: Function) { ensureSetup(); const watcher = {keys: [...keys], fn, active: true, raw: false}; watchers.push(watcher); return () => { watcher.active = false; }; },
      watchAll(fn: Function) { ensureSetup(); const watcher = {keys: null, fn, active: true, raw: false}; watchers.push(watcher); return () => { watcher.active = false; }; },
      watchRaw(keys: string[], fn: Function) { ensureSetup(); const watcher = {keys: [...keys], fn, active: true, raw: true}; watchers.push(watcher); return () => { watcher.active = false; }; },
      watchRawAll(fn: Function) { ensureSetup(); const watcher = {keys: null, fn, active: true, raw: true}; watchers.push(watcher); return () => { watcher.active = false; }; },
    },
    state: {bool: (s: string, v: boolean) => state('bool', s, v), enum: (s: string, v: string, o: __wcStateOptions) => state('enum', s, v, o), string: (s: string, v: string, o?: __wcStateOptions) => state('string', s, v, o), numberDiscrete: (s: string, v: number, o?: __wcStateOptions) => state('number.discrete', s, v, o), numberRange: (s: string, v: number, o: __wcStateOptions) => state('number.range', s, v, o)},
    expose: {
      value: expose,
      state(key: string, handle: __wcState) { expose(key, handle.external);  },
      method<A extends unknown[], R>(key: string, fn: (...args: A) => R, project?: (value: R) => R) {  expose(key, (...args: unknown[]) => { ensureExternal(); const result = invoke(fn, args, false) as R; return project ? project(result) : result; }); },
      event(key: string) { ensureSetup(); if (own(exposes, key) || events.has(key)) throw new Error('Duplicate expose: ' + key); events.add(key); },
    },
    lifecycle: {onCreated(fn) { ensureSetup(); lifecycle.created.push(fn); }, onMounted(fn) { ensureSetup(); lifecycle.mounted.push(fn); }, onUpdated(fn) { ensureSetup(); lifecycle.updated.push(fn); }, onUnmounted(fn) { ensureSetup(); lifecycle.unmounted.push(fn); }, onBeforeDispose(fn) { ensureSetup(); lifecycle.beforeDispose.push(fn); }},
  };
  const owner: __wcOwner = {
    
    
    
    identity: Symbol('compiled-logical-owner'), def, exposes, render: undefined,

    style: __wcStyle, props: () => resolved as __wcPropsSnapshot,

    get epoch() { return epoch; }, get view() { return view; },
    hydrate, update: () => schedule(true), reconcile,

    created() { setup = false; fire('created'); },
    dispose() {
      if (!alive || disposing) return; disposing = true;
      
      let error: unknown;
      try { detach(); } catch (caught) { error = caught; }
      try { fire('beforeDispose'); } catch (caught) { error ??= caught; }
      finally {

        __wcStyle.dispose(); host.attribute('data-pui-style', null);

        __wcOwnerScopes.delete(host); context.dispose(); host.bindContext(null);
         alive = false; ++epoch; dirty = false; watchers.length = 0; emissions.length = 0;
        for (const handle of states) handle.subscribers.clear();
        for (const callbacks of Object.values(lifecycle)) callbacks.length = 0;
        host.clear();
      }
      if (error !== undefined) throw error;
    },
  };
  return owner;
}

export class RelayStatus extends HTMLElement {
  private __wcOwner: __wcOwner | null = null;
  private __wcPort: BrowserPort | null = null;
  private __wcRaw: Record<string, unknown> = {};
  private __wcDisconnect = 0;
  private __wcClosed = false;
  private __wcAssociations: Readonly<{ controlLabel?: object | null }> | undefined;
  get instanceAssociations(): Readonly<{ controlLabel?: object | null }> | undefined { return this.__wcAssociations; }
  set instanceAssociations(value: Readonly<{ controlLabel?: object | null }> | undefined) {
    if (this.__wcClosed) throw new Error('Custom element is disposed');
{ const __wcInputAssociations = value;
    if (__wcInputAssociations !== undefined) {
      if (__wcInputAssociations === null || typeof __wcInputAssociations !== 'object' || Object.getPrototypeOf(__wcInputAssociations) !== Object.prototype)
        throw new TypeError('[InstanceAssociations] expected a plain record');
      for (const key of Reflect.ownKeys(__wcInputAssociations)) if (key !== 'controlLabel')
        throw new TypeError('[InstanceAssociations] unknown association key');
      if (Object.prototype.hasOwnProperty.call(__wcInputAssociations, 'controlLabel') && Reflect.get(__wcInputAssociations, 'controlLabel') != null)
        throw new Error('[ControlLabel] this Prototype has not declared Label or target participation');
    }
  }
    this.__wcAssociations = value;

  }
  static get observedAttributes(): string[] { return ['instance-associations', 'instanceassociations']; }
  attributeChangedCallback(name: string, _previous: string | null, value: string | null): void {
    if (value !== null) throw new TypeError('[InstanceAssociations] use the instanceAssociations property, not an attribute string');
  }
  get logicalOwner(): symbol | null { return this.__wcOwner?.identity ?? null; }
  get viewEpoch(): number { return this.__wcOwner?.epoch ?? 0; }
  get present(): boolean { return this.__wcOwner?.view ?? false; }
  connectedCallback(): void {
    ++this.__wcDisconnect;
    if (this.__wcClosed) return;
    if (this.__wcOwner) {
      const owner = this.__wcOwner;
      if (!owner.view) {
        const version = this.__wcDisconnect;
        // Finish an enclosing native slot commit before retrying a retained owner.
        queueMicrotask(() => {
          if (this.__wcClosed || owner !== this.__wcOwner || version !== this.__wcDisconnect || !this.isConnected || owner.view) return;
          owner.reconcile();
        });
      }
      return;
    }
    const port = createNativeBrowserPort(this, false, undefined, undefined);
    this.__wcPort = port;
    const owner = __wcCreateOwner(port);
    this.__wcOwner = owner;
    const __wcDef = owner.def;



    const __wcStyle = owner.style;
    const __wcOwnerProps = owner.props;


    try {
      owner.render = ((def: __wcDef) => {
        // Source "input.proto.ts":3:3
        def.feedback.style.use(({"kind":"tw","tokens":["inline-flex","items-center","rounded-full","px-3","py-1","text-sm"],"groups":["display","items-","rounded","px-","py-","text-size"]} as const));
        // Source "input.proto.ts":4:3
        return (r: __wcRenderer) => {
          // Source "input.proto.ts":4:17
          const __wcOutput0=((__wcReceiver2: __wcRenderer, __wcTag3: string, __wcArg4?: unknown, __wcArg5?: unknown) => {
      if(!/^[A-Za-z][A-Za-z0-9:_-]*$/.test(__wcTag3))throw new TypeError('Invalid template tag');
      
      return () => {const __wcElement6=__wcReceiver2.nativeFrame.document.createElement(__wcTag3);
        
        for(const __wcItem8 of ((__wcArg4 as unknown[]) as unknown[])){if(typeof __wcItem8==='string'||typeof __wcItem8==='number'){__wcElement6.appendChild(__wcReceiver2.nativeFrame.document.createTextNode(String(__wcItem8)));} else {throw new TypeError('Invalid template child');}}
        return __wcElement6;};
    })(r, "span", ["ChatGPT / Claude · MCP"]);
          const __wcFragment1=r.nativeFrame.document.createDocumentFragment();
__wcFragment1.appendChild((__wcOutput0 as ()=>Node)());
          return __wcFragment1;
        };
      })(__wcDef);
      owner.hydrate(this.__wcRaw);
      owner.created();
      owner.reconcile();
      port.accept();
    } catch (error) {
      try { owner.dispose(); }
      finally { port.dispose(); this.__wcPort = null; this.__wcOwner = null; }
      throw error;
    }
  }
  disconnectedCallback(): void {
    const version = ++this.__wcDisconnect;
    const owner = this.__wcOwner;
    queueMicrotask(() => {
      if (version !== this.__wcDisconnect || this.isConnected || !owner || owner !== this.__wcOwner) return;
      this.__wcOwner = null;
      try { owner.dispose(); } finally { this.__wcPort?.dispose(); this.__wcPort = null; }
    });
  }
  setProps(next: GeneratedProps & Record<string, unknown>): void {
    if (this.__wcClosed) throw new Error('Custom element is disposed');

    if (Object.prototype.hasOwnProperty.call(next, 'instanceAssociations')) throw new TypeError('[InstanceAssociations] use the instanceAssociations property, outside Props');
    this.__wcRaw = { ...next };
    if (this.__wcOwner) { this.__wcOwner.hydrate(this.__wcRaw);  }
  }
  update(): void {
    if (this.__wcClosed) throw new Error('Custom element is disposed');
    this.__wcOwner?.update();
  }
  getExposes(): Partial<GeneratedExposes> {
    return this.isConnected && this.__wcOwner ? { ...this.__wcOwner.exposes } as Partial<GeneratedExposes> : {};
  }
  dispose(): void {
    if (this.__wcClosed) return;
    this.__wcClosed = true;
    ++this.__wcDisconnect;
    const owner = this.__wcOwner;
    this.__wcOwner = null;
    try { owner?.dispose(); } finally { this.__wcPort?.dispose(); this.__wcPort = null; }
  }
}
export function register(tagName = "pui-compiled-element", registry: CustomElementRegistry = customElements): typeof RelayStatus {
  const existing = registry.get(tagName);
  if (existing && existing !== RelayStatus) throw new Error('Custom element tag already registered: ' + tagName);
  if (!existing) registry.define(tagName, RelayStatus);
  return RelayStatus;
}
export default RelayStatus;
