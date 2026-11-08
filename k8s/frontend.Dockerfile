FROM nginx:1.28-alpine
COPY frontend/ /usr/share/nginx/html/
COPY k8s/frontend-nginx.conf /etc/nginx/nginx.conf
STOPSIGNAL SIGQUIT
