/** Application-owned instructions for one turn. Not user text, never persisted as a message. */
export interface ProjectInstructions {
  /** Equal ids mean equal text; adapters compare ids, never text. */
  readonly id: string;
  readonly text: string;
}
