/**
 * Validación de la cédula ecuatoriana.
 *
 * Sirve para dos cosas:
 *   1. Detectar en el webhook que un mensaje "0102030405" es una cédula y no
 *      una pregunta, sin tener que llamar al modelo.
 *   2. Descartar de entrada los números inventados, para que un atacante no
 *      pueda ir probando cifras al azar contra el padrón.
 *
 * Reglas (registro civil del Ecuador):
 *   - 10 dígitos.
 *   - Los dos primeros son la provincia: 01 a 24, o 30 (ecuatorianos en el
 *     exterior).
 *   - El tercero es menor a 6 en las cédulas de persona natural.
 *   - El último es un dígito verificador de módulo 10, con coeficientes
 *     2,1,2,1,2,1,2,1,2 sobre los nueve primeros: los productos de dos cifras
 *     se reducen restándoles 9.
 */

/** Quita todo lo que no sea dígito. */
export function normalizarCedula(texto) {
  return String(texto ?? '').replace(/[^0-9]/g, '');
}

/** true si la cadena es una cédula ecuatoriana bien formada. */
export function esCedulaValida(texto) {
  const cedula = normalizarCedula(texto);
  if (cedula.length !== 10) return false;

  const provincia = Number(cedula.slice(0, 2));
  if (!((provincia >= 1 && provincia <= 24) || provincia === 30)) return false;

  // El tercer dígito distingue el tipo de documento; 6 y 7 no son de persona natural.
  const tercero = Number(cedula[2]);
  if (tercero > 5) return false;

  const coeficientes = [2, 1, 2, 1, 2, 1, 2, 1, 2];
  let suma = 0;
  for (let i = 0; i < 9; i += 1) {
    let producto = Number(cedula[i]) * coeficientes[i];
    if (producto >= 10) producto -= 9;
    suma += producto;
  }

  const verificador = (10 - (suma % 10)) % 10;
  return verificador === Number(cedula[9]);
}

/**
 * Extrae la cédula de un mensaje del paciente, si la hay.
 *
 * Acepta que venga suelta o dentro de una frase ("mi cédula es 0102030405"),
 * y tolera puntos o guiones. Devuelve null si el mensaje no contiene ninguna
 * secuencia de 10 dígitos que pase la validación.
 */
export function extraerCedula(texto) {
  if (!texto) return null;

  // Se buscan secuencias de 10 dígitos permitiendo separadores comunes.
  const candidatos = String(texto).match(/\d[\d.\-\s]{8,20}\d/g) ?? [];

  for (const candidato of candidatos) {
    const limpio = normalizarCedula(candidato);
    if (limpio.length === 10 && esCedulaValida(limpio)) return limpio;

    // "0102030405 codigo 123456" deja 16 dígitos pegados: probamos el prefijo.
    if (limpio.length > 10) {
      const prefijo = limpio.slice(0, 10);
      if (esCedulaValida(prefijo)) return prefijo;
    }
  }

  return null;
}

/**
 * Extrae un código de vinculación (6 dígitos) de un mensaje.
 * Se ignoran las secuencias de 10 dígitos, que son cédulas.
 */
export function extraerCodigo(texto) {
  if (!texto) return null;
  const coincidencias = String(texto).match(/\b\d{6}\b/g) ?? [];
  return coincidencias[0] ?? null;
}
