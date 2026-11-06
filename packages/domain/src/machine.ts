// A state machine's answer, the shape every context's machine returns: the
// route and pickup machines (execution/transitions), the ticket and alert
// machines (resolution/transitions), the settlement and review machines
// (finance/transitions).

/** What a machine answers: the next status, nothing to do, or a refusal with its sentence. */
export type Transition<Status extends string> = { kind: "move"; to: Status } | { kind: "stay" } | { kind: "refuse"; sentence: string }
