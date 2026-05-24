# Tracky
Your adorable buddy who helps you clock in and out, manage teams, and fill forms like a pro!

Grab the [Latest Release](https://github.com/cmish00/tracky/releases/latest)

## Bonus
**Built-In integration with some gaming communities.**
- Users can enter a "team code" to gain access to pre-configured departments with additional options like pre-filled form generation!

**Closed Demo for Deartment of Justice Roleplay Community Members: ![tracky.sagov.dev](https://tracky.sagov.dev); reach out for the `key`.**

# Previews
![Cover Image](/assets/images/cover.png)
![Cover Image](/assets/images/cover2.png)
![Cover Image](/assets/images/cover3.png)
![Cover Image](/assets/images/cover4.png)
![Cover Image](/assets/images/cover5.png)

# Installation
**Install directly on a host machine with Docker previously installed.**
- Download the required files.
- Navigate to the `project` folder within the Docker or System CLI.
- Set environment variables inside `docker-compose.yml` | Default working values have already been set. This step is optional.
- Run `docker compose up --build

# Docker Compose
**Install through a Docker Compose manager like Portainer.** | [Docker Hub](https://hub.docker.com/repository/docker/cmish00/tracky-frontend/)
```
services:
  redis:
    image: redis:7-alpine
    command: redis-server --appendonly yes
    volumes:
      - /local/path/to/your/data:/data # a directory on your computer
    restart: unless-stopped

  backend:
    image: cmish00/tracky-backend:latest
    environment:
      - REDIS_URL=redis://redis:6379
      - PORT=3000 # not touched
      - AUTH_SECRET=trk_8f6b7a2e4d91d0a73f5j92b1g86d40c9b7e51f3a24wz8e66
      - ADMIN_USERNAME=admin # default admin account username
      - ADMIN_PASSWORD=admin # default admin account password
      - CORS_ORIGINS=* #optional comma seperated list of allowed URLs
    ports:
      - "3100:3000" # public_port:3000
    depends_on:
      - redis
    restart: unless-stopped

  frontend:
    image: cmish00/tracky-frontend:latest
    environment:
      - APP_NAME=TRACKY
      - APP_DESC=Department Time Tracking Control Panel
      - TAB_TITLE=Tracky
      - API_BASE=
    ports:
      - "8100:80" # web_ui_port:80
    depends_on:
      - backend
    restart: unless-stopped


```
