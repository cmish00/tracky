# Tracky

Tracky is a Docker Compose web app for personal department/subdivision time tracking.

## Run

```powershell
docker compose up -d --build
```

Then open http://localhost:8080.

Default administrator credentials are `admin` / `admin123`. Change the password after first login.

## Features

- Personal department and subdivision catalogs seeded from the requested defaults.
- Per-user monthly required hour targets at both department and subdivision level.
- Per-user enable/disable toggles that hide departments and subdivisions from tracking and monthly views without deletion.
- Drag-and-drop per-user ordering of departments and their subdivisions.
- LOCAL/ZULU display and entry modes with monthly boundaries calculated in the selected time basis.
- Live department patrols with up to three selected subdivisions that can be re-activated sequentially, including returns to department-only duty.
- Editable single- and multi-assignment patrol logs with timed subdivision boundaries.
- Current-month shift-log overview with historical month and department filters, plus combined per-subdivision patrol totals.
- Per-user LOCAL/ZULU and 12H/24H display modes for logged timestamps.
- Monthly status dashboard with department and subdivision rollups and `HH:MM` totals.
- Normal user and administrator roles.
- Administrator user creation, role updates, password resets, and deletion.
- Administrator-only active patrol overview showing each currently active user, assignment, start time, and live patrol duration.
- Team management with admin-defined join keys, user self-join, per-user team ordering, and configurable structure-edit permissions.
- A locked `Department of Justice RP` (`DOJ`) team containing the default department catalog, alongside unrestricted `Personal Departments`.
- Redis-backed persistence.

Ports can be changed with `TRACKY_PORT` and `TRACKY_API_PORT`.

## Access URL

Tracky allows browser access from all origins by default.

To restrict access, optionally set `ACCESS_URL` to a comma-separated list of allowed origins:

```powershell
$env:ACCESS_URL='https://tracky.example.com,https://staff.example.com'
docker compose up -d --build
```

The backend still understands `CORS_ORIGINS` for deployments using an older Compose file, but new configurations should use `ACCESS_URL`.
