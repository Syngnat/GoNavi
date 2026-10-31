FROM debian:bookworm-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    krb5-kdc krb5-admin-server krb5-user openssl tini \
    && apt-get clean
COPY krb5-container.conf /etc/krb5.conf
COPY kdc.conf /etc/krb5kdc/kdc.conf
COPY kdc.acl /etc/krb5kdc/kadm5.acl
COPY init-kdc.sh init-tls.sh serve-kdc.sh /usr/local/lib/gonavi-auth/
ENTRYPOINT ["/usr/bin/tini", "--", "/bin/sh", "/usr/local/lib/gonavi-auth/serve-kdc.sh"]
