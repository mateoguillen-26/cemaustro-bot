/**
 * Utilidades de fecha y hora.
 *
 * Todo se guarda en UTC (ISO 8601) y solo se traduce a la zona del paciente
 * al momento de mostrarlo. Así los cambios de zona nunca corrompen los datos.
 */
import { formatInTimeZone, toZonedTime } from 'date-fns-tz';
import { config } from '../config.js';

/** Zona horaria de un paciente, con la del sistema como respaldo. */
export function zonaDe(paciente) {
  return paciente?.timezone || config.zonaHoraria;
}

/** Fecha actual en UTC, en formato ISO. */
export function ahoraISO() {
  return new Date().toISOString();
}

/** Suma minutos a la hora actual y devuelve el ISO en UTC. */
export function enMinutos(minutos) {
  return new Date(Date.now() + minutos * 60_000).toISOString();
}

/** Suma días a la hora actual y devuelve el ISO en UTC. */
export function enDias(dias) {
  return new Date(Date.now() + dias * 86_400_000).toISOString();
}

/** true si la fecha ISO ya quedó atrás. */
export function yaPaso(iso) {
  if (!iso) return true;
  const fecha = new Date(iso);
  return Number.isNaN(fecha.getTime()) ? true : fecha.getTime() <= Date.now();
}

/** Formatea una fecha ISO para leerla, ej. "lunes 15 de enero, 08:00". */
export function describirFecha(iso, zona = config.zonaHoraria) {
  if (!iso) return '';
  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) return '';
  return formatInTimeZone(fecha, zona, "EEEE d 'de' MMMM, HH:mm", { locale: undefined });
}

/** Formato corto para tablas del panel: "15/01/2026 08:00". */
export function fechaCorta(iso, zona = config.zonaHoraria) {
  if (!iso) return '—';
  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) return '—';
  return formatInTimeZone(fecha, zona, 'dd/MM/yyyy HH:mm');
}

/** Solo el día: "15/01/2026". */
export function diaCorto(iso, zona = config.zonaHoraria) {
  if (!iso) return '—';
  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) return '—';
  return formatInTimeZone(fecha, zona, 'dd/MM/yyyy');
}

/** Fecha y hora actual del paciente, tal como se le pasa al modelo. */
export function fechaActualParaPrompt(zona = config.zonaHoraria) {
  return formatInTimeZone(new Date(), zona, "EEEE d 'de' MMMM 'de' yyyy, HH:mm (XXX)");
}

/**
 * Convierte una fecha ISO con zona (la que devuelve el modelo, ej.
 * "2026-01-15T08:00:00-05:00") a ISO en UTC. Devuelve null si no es válida.
 */
export function aUtcISO(texto) {
  if (!texto) return null;
  const fecha = new Date(texto);
  return Number.isNaN(fecha.getTime()) ? null : fecha.toISOString();
}

/** Convierte un ISO en UTC a un objeto Date "movido" a la zona indicada. */
export function enZona(iso, zona = config.zonaHoraria) {
  return toZonedTime(new Date(iso), zona);
}
