FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y nginx fcgiwrap git && rm -rf /var/lib/apt/lists/*
COPY nginx.conf /etc/nginx/nginx.conf
RUN mkdir -p /repos && chown -R www-data:www-data /repos
# Trust all repos (allows git-http-backend to serve repos created by different users)
RUN git config --system --add safe.directory '*'
EXPOSE 3500
CMD ["sh", "-c", "fcgiwrap -s unix:/var/run/fcgiwrap.sock & sleep 0.5 && chmod 666 /var/run/fcgiwrap.sock && nginx -g 'daemon off;'"]
