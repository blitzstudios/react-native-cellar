/**
 * The DEV probe for "is React rendering right now?", read off the hooks dispatcher: its members throw everywhere
 * except render, which is what separates a render from an effect.
 */
/** A `\n    at <Component>` chain for the component rendering now, or `null` outside render and in production. */
export declare function renderPhaseOwnerStack(): string | null;
//# sourceMappingURL=render_phase.d.ts.map