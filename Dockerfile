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

# Copy installed dependencies from the builder stage
COPY --from=builder /app/node_modules ./node_modules

# Copy the application files
COPY . .

# Expose port 8080
EXPOSE 8080

# Start the http-server
CMD [ "npx", "http-server", "-p", "8080", "-c-1" ]
