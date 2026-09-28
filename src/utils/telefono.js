/**
 * Teléfonos escritos a mano en el panel o en el CSV del padrón.
 *
 * WhatsApp identifica a cada número en formato internacional, solo dígitos y
 * sin '+': un celular ecuatoriano llega como 593 + 9 dígitos (593991234567).
 * Para que un paciente del padrón coincida con quien escribe, el número hay
 * que guardarlo exactamente así.
 *
 * Aquí la gente escribe el celular como lo usa a diario (099…, 098…, 097…),
 * así que se convierte al formato de WhatsApp:
 *
 *   0991234567       -> 593991234567   (formato local)
 *   991234567        -> 593991234567   (sin el 0)
 *   +593 99 123 4567 -> 593991234567   (ya internacional)
 *   593 0991234567   -> 593991234567   (código de país y además el 0)
 *   00593991234567   -> 593991234567   (prefijo internacional 00)
 *
 * Cualquier otro número (uno extranjero, por ejemplo) se deja tal cual.
 */

/** Quita todo lo que no sea dígito y lleva un celular ecuatoriano a 5939XXXXXXXX. */
export function normalizarTelefono(valor) {
  let digitos = String(valor ?? '').replace(/[^0-9]/g, '');
  if (!digitos) return null;

  if (digitos.startsWith('00')) digitos = digitos.slice(2);

  if (/^09\d{8}$/.test(digitos)) return `593${digitos.slice(1)}`;
  if (/^9\d{8}$/.test(digitos)) return `593${digitos}`;
  if (/^59309\d{8}$/.test(digitos)) return `593${digitos.slice(4)}`;

  return digitos;
}

/**
 * true si, ya normalizado, tiene forma de número internacional: no empieza
 * por 0 y tiene entre 8 y 15 dígitos. Un "099123456" al que le falta una
 * cifra no pasa, en lugar de guardarse y no coincidir nunca con nadie.
 */
export function esTelefonoValido(telefono) {
  return /^[1-9]\d{7,14}$/.test(String(telefono ?? ''));
}
