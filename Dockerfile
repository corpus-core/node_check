# Stage 1: Install dependencies
FROM node:18-alpine AS builder
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install

# Stage 2: Serve static files with a minimal web server
FROM node:18-alpine
WORKDIR /app

# Set a default port. Can be overridden at runtime.
ENV PORT 8080

# Copy installed dependencies from the builder stage
COPY --from=builder /app/node_modules ./node_modules

# Copy the application files
COPY . .

# Expose the port defined by the variable
EXPOSE ${PORT}

# Start the http-server, serving from the app directory
# The server will automatically find index.html and the public folder
CMD ["node", "src/server.mjs"]
