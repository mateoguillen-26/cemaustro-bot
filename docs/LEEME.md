# Carpeta de documentos

Deje aquí los archivos `.md` o `.txt` con el material del consultorio y córralos con:

```bash
npm run importar-docs
```

Cada archivo se convierte en un documento de la base de conocimiento. El nombre
del archivo pasa a ser el título, así que póngale uno descriptivo
(`alimentacion-plato.md`, no `doc1.md`). Volver a correr el comando reemplaza
el documento anterior con el mismo título, de modo que se puede ejecutar cada
vez que actualice una guía.

**Separe los temas con una línea en blanco.** El texto se parte por párrafos: si
todo va en un bloque gigante, los fragmentos quedan mezclados y la búsqueda
pierde precisión.

Este archivo (`LEEME.md`) también se importaría, así que muévalo o bórrelo
cuando ponga material real. El de ejemplo (`ejemplo-...`) está para que vea el
formato; bórrelo también.
