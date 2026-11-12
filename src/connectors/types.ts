/**
 * Interfaz común a todos los conectores de correo (Gmail vía API, Proton vía
 * IMAP del Bridge). El resto de la app solo conoce esta interfaz, de modo que
 * el motor y el ejecutor no dependen del proveedor concreto.
 */
import type { AccountKind, ActionKind, Message } from '../core/types';

export interface MailConnector {
  /** Cuenta que representa este conector. */
  readonly account: AccountKind;

  /**
   * Trae los correos candidatos (normalmente la bandeja de entrada, acotada por
   * `limit`). El motor evalúa las reglas sobre esta lista.
   */
  listMessages(opts?: { limit?: number }): Promise<Message[]>;

  /**
   * Aplica una acción a un correo por id. `labelName` solo se usa cuando
   * `action === 'label'`.
   */
  apply(action: ActionKind, messageId: string, labelName?: string): Promise<void>;

  /** Comprueba que el conector puede conectarse (credenciales, red). */
  verify(): Promise<void>;
}
