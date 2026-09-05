/**
 * Cliente único de OpenAI, compartido por transcripción, respuestas y embeddings.
 * Se crea una sola vez para no abrir un pool de conexiones por cada llamada.
 */
import OpenAI from 'openai';
import { config } from '../config.js';

export const cliente = new OpenAI({
  apiKey: config.openai.apiKey,
  baseURL: config.openai.baseUrl,
  timeout: 60_000,
  maxRetries: 2,
});
