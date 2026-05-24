# NewsDesk
A lightweight news-style ticker and management system to generate full-screen webpage-viewable tickers meant to be displayed in streaming softwares like OBS -- But Cute! &lt;3

Grab the [Latest Release](https://github.com/cmish00/newsdesk/releases/latest)


# Previews
![Cover Image](/assets/images/cover.png)
![Cover Image](/assets/images/cover2.png)
![Cover Image](/assets/images/cover3.png)
![Cover Image](/assets/images/cover5.gif)

# Installation
**Install directly on a host machine with Docker previously installed.**
- Download the required files.
- Navigate to the `project` folder within the Docker or System CLI.
- Set environment variables inside `docker-compose.yml` | Default working values have already been set. This step is optional.
- Run `docker compose up --build

# Docker Compose
**Install through a Docker Compose manager like Portainer.** | [Docker Hub](https://hub.docker.com/repository/docker/cmish00/newsdesk-frontend/)
```
version: '3.8' 
# Legacy versioning system | Not needed in most deployments.

services:
  redis: 
  # Persistent Storage Application
    image: redis:7-alpine
    command: redis-server --appendonly yes --notify-keyspace-events Ex
    ports:
      - "6379:6379"
    volumes:
      - path/to/directory/redis_data:/data # ${host/machine/path/redis_data}:data
    restart: unless-stopped

  backend: 
  # Not Accessed Directly
    image: cmish00/newsdesk-backend
    environment:
      - REDIS_URL=redis://redis:6379
      - PORT=3000
      - AUTH_SECRET=wzn_8f6b7a2e4d91c0a73f5e92b1a86d40c9b7e51f3a24dc8e66
      - ADMIN_USERNAME=admin
      - ADMIN_PASSWORD=admin
    ports:
      - "3220:3000"
    depends_on:
      - redis
    restart: unless-stopped

  frontend: 
  # User Accessible Webpage
    image: cmish00/newsdesk-frontend
    environment:
      - PANEL_NAME=NEWS DESK 
      # This is the main title seen at the top of the webpage.
      - PANEL_DESC=Real-Time Ticker & Queue Control Management System 
      # This is the smaller subtext below the main title.
      - TAB_Title=Control Panel | News Desk 
      # This is what appears in your browser's tab.
      - FALLBACK_STREAM=[SYSTEM] ALL STATIONS CLEAR // ROTATING TIMELINE STANDBY
      # This is the message that will scroll across a ticker by default when no headline stories are defined. This can be further customised per-ticker in the editor.
    ports:
      - "8220:80" 
      # This will be forwarded behind a reverse proxy like NGINX or be accessed directly by the end user.
    depends_on:
      - backend
    restart: unless-stopped

```
