FROM node:18-slim
RUN apt-get update && apt-get install -y python3 python3-pip ffmpeg && pip3 install yt-dlp --break-system-packages
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
