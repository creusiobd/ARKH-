## Architecture migration

The repository is being migrated incrementally to a modular monolith.

### Entrypoints

- `server.ts` remains the legacy production entrypoint while existing route groups are migrated.
- `src/app/modular-server.ts` is the new composition root for migrated modules.
- Enable the modular entrypoint explicitly with:

```bash
ARKHE_MODULAR_SERVER=true npx tsx src/app/modular-server.ts
```

The modular entrypoint currently exposes:

- `GET /api/v2/health`
- `GET /api/v2/opportunities/health`
- `GET|POST /api/v2/opportunities/score`

### Migration rule

New functionality should be added under `src/modules/<module>` using domain, application, controller, infrastructure, and routes layers. Existing legacy routes should be moved one bounded context at a time; do not duplicate business rules in both entrypoints.
