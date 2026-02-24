# Use Red Hat UBI Node.js image - works perfectly with OpenShift
FROM registry.access.redhat.com/ubi9/nodejs-20:latest

# Set working directory
WORKDIR /opt/app-root/src

# Copy package files
COPY package*.json ./

# Install dependencies
# Using npm ci for cleaner installs in production
RUN npm ci --only=production && \
    npm cache clean --force

# Copy application files
COPY server.js ./
COPY public ./public

# Expose port (default 3000)
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); })"

# Run as non-root user (already set by base image)
USER 1001

# Start the application
CMD ["node", "server.js"]
