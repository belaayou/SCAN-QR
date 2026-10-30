/* ============================================================
   SCAN-QR — SERVICE WORKER
   Version : 14
   Objectifs :
   - Mise en cache contrôlée des fichiers statiques
   - Mise à jour des fichiers de l'application
   - Repli hors ligne sur la page principale
   - Aucune mise en cache ni interception des données Supabase

   Changements par rapport à la v13 :
   - Navigation : une redirection (opaqueredirect) ou une réponse
     HTTP (404, 500...) est transmise telle quelle au navigateur.
     Le repli sur index.html n'a lieu QUE si le réseau est
     réellement indisponible (avant : toute réponse non 200
     renvoyait l'ancienne page en cache).
   - Fichiers locaux : réseau d'abord, cache en secours (avant :
     cache d'abord, ce qui pouvait figer un ancien fichier).
   - Échec réseau d'une ressource : Response.error() (erreur réseau
     normale) au lieu d'un faux 503 texte servi comme un script.
   ============================================================ */

"use strict";

const SW_VERSION = "14";

const APP_CACHE = `scan-qr-app-v${SW_VERSION}`;
const RUNTIME_CACHE = `scan-qr-runtime-v${SW_VERSION}`;

const APP_SHELL = [
    "./",
    "./index.html",
    "./manifest.json",
    "./IMG_20260413_130653.png"
];

/*
 * Ne pas ajouter ici les URL de l'API Supabase.
 * Les bibliothèques externes sont mises en cache séparément.
 */

const VENDOR_HOSTS = [
    "unpkg.com",
    "cdn.jsdelivr.net"
];

/* ------------------------------------------------------------
   OUTILS
   ------------------------------------------------------------ */

function appURL(path) {
    return new URL(path, self.registration.scope).href;
}

function isValidResponse(response) {
    return Boolean(
        response &&
        response.ok &&
        response.status === 200 &&
        response.type !== "opaque"
    );
}

function isSupabaseRequest(url) {
    const hostname = url.hostname.toLowerCase();

    return (
        hostname.endsWith(".supabase.co") ||
        hostname.endsWith(".supabase.com")
    );
}

function isVendorRequest(url) {
    return VENDOR_HOSTS.includes(url.hostname.toLowerCase());
}

function isSameOrigin(url) {
    return url.origin === self.location.origin;
}

async function cacheResponse(cacheName, request, response) {
    if (!isValidResponse(response)) {
        return;
    }

    const cache = await caches.open(cacheName);
    await cache.put(request, response.clone());
}

/* ------------------------------------------------------------
   INSTALLATION
   ------------------------------------------------------------ */

self.addEventListener("install", event => {
    event.waitUntil(
        (async () => {
            const cache = await caches.open(APP_CACHE);

            /*
             * Chaque fichier est tenté séparément.
             * Un fichier manquant ne bloque pas toute
             * l'installation du Service Worker.
             */
            await Promise.allSettled(
                APP_SHELL.map(async path => {
                    const url = appURL(path);

                    const response = await fetch(
                        new Request(url, {
                            cache: "reload"
                        })
                    );

                    if (isValidResponse(response)) {
                        await cache.put(url, response.clone());
                    } else {
                        console.warn(
                            "[SCAN-QR SW] Fichier non mis en cache :",
                            url
                        );
                    }
                })
            );

            /*
             * Active la nouvelle version dès que possible.
             */
            await self.skipWaiting();
        })()
    );
});

/* ------------------------------------------------------------
   ACTIVATION
   ------------------------------------------------------------ */

self.addEventListener("activate", event => {
    event.waitUntil(
        (async () => {
            const allowedCaches = new Set([
                APP_CACHE,
                RUNTIME_CACHE
            ]);

            const cacheNames = await caches.keys();

            await Promise.all(
                cacheNames.map(cacheName => {
                    /*
                     * Supprime uniquement les anciens caches
                     * identifiés comme appartenant à SCAN-QR.
                     * Aucune donnée locale (localStorage,
                     * IndexedDB) n'est touchée.
                     */
                    if (
                        cacheName.startsWith("scan-qr-") &&
                        !allowedCaches.has(cacheName)
                    ) {
                        return caches.delete(cacheName);
                    }

                    return Promise.resolve(false);
                })
            );

            await self.clients.claim();

            console.info(
                `[SCAN-QR SW] Activé : v${SW_VERSION}`
            );
        })()
    );
});

/* ------------------------------------------------------------
   RECHERCHE DANS LES CACHES ACTUELS
   ------------------------------------------------------------ */

async function findAppCache(request) {
    const cache = await caches.open(APP_CACHE);
    return cache.match(request);
}

async function findRuntimeCache(request) {
    const cache = await caches.open(RUNTIME_CACHE);
    return cache.match(request);
}

/* ------------------------------------------------------------
   NAVIGATION : RÉSEAU D'ABORD
   Le repli sur le cache n'est utilisé que si le réseau échoue.
   ------------------------------------------------------------ */

async function handleNavigation(request) {
    let response;

    try {
        response = await fetch(request);
    } catch (error) {
        /*
         * Réseau réellement indisponible : repli hors ligne.
         */
        const cachedIndex = await findAppCache(
            appURL("./index.html")
        );

        if (cachedIndex) {
            return cachedIndex;
        }

        return new Response(
            `<!doctype html>
            <html lang="fr">
            <head>
              <meta charset="utf-8">
              <meta name="viewport"
                    content="width=device-width, initial-scale=1">
              <meta name="theme-color" content="#eaea00">
              <title>SCAN-QR</title>
            </head>
            <body>
              <h2>SCAN-QR</h2>
              <p>
                La page de l'application n'est pas disponible
                hors connexion.
              </p>
              <p>
                Vérifiez votre connexion Internet puis réessayez.
              </p>
            </body>
            </html>`,
            {
                status: 503,
                headers: {
                    "Content-Type": "text/html; charset=utf-8",
                    "Cache-Control": "no-store"
                }
            }
        );
    }

    /*
     * Redirection (opaqueredirect), 404, 500... :
     * la réponse du serveur est transmise telle quelle.
     * Elle n'est ni masquée par une ancienne page ni mise en cache.
     */
    if (!isValidResponse(response)) {
        return response;
    }

    /*
     * La réponse de navigation est conservée sous la clé
     * index.html, uniquement pour la page principale de cette PWA.
     */
    try {
        const requestedURL = new URL(request.url);
        const mainURL = appURL("./");
        const indexURL = appURL("./index.html");

        if (
            requestedURL.href === mainURL ||
            requestedURL.href === indexURL
        ) {
            const cache = await caches.open(APP_CACHE);
            await cache.put(indexURL, response.clone());
        }
    } catch (error) {
        /* Échec d'écriture du cache : sans conséquence. */
    }

    return response;
}

/* ------------------------------------------------------------
   FICHIERS LOCAUX DE L'APPLICATION : RÉSEAU D'ABORD
   Justification : fichiers peu nombreux et légers ; évite de
   servir un ancien fichier incompatible avec la page HTML.
   Le cache sert uniquement de secours hors connexion.
   ------------------------------------------------------------ */

async function handleStaticRequest(request) {
    try {
        const response = await fetch(request);

        if (isValidResponse(response)) {
            await cacheResponse(
                APP_CACHE,
                request,
                response
            );
        }

        return response;
    } catch (error) {
        const cachedResponse = await findAppCache(request);

        if (cachedResponse) {
            return cachedResponse;
        }

        return Response.error();
    }
}

/* ------------------------------------------------------------
   BIBLIOTHÈQUES EXTERNES : CACHE D'ABORD
   Justification : bibliothèques tierces ; une fois chargées avec
   succès, elles restent disponibles hors connexion.
   Remarque : un script chargé sans attribut crossorigin est une
   réponse "opaque", qui n'est volontairement pas mise en cache.
   ------------------------------------------------------------ */

async function handleVendorRequest(request) {
    const cachedResponse = await findRuntimeCache(request);

    if (cachedResponse) {
        return cachedResponse;
    }

    try {
        const response = await fetch(request);

        if (isValidResponse(response)) {
            await cacheResponse(
                RUNTIME_CACHE,
                request,
                response
            );
        }

        return response;
    } catch (error) {
        /*
         * Erreur réseau normale : le navigateur signale l'échec
         * de chargement du script, comme sans Service Worker.
         */
        return Response.error();
    }
}

/* ------------------------------------------------------------
   INTERCEPTION DES REQUÊTES
   ------------------------------------------------------------ */

self.addEventListener("fetch", event => {
    const request = event.request;

    /*
     * Ne jamais intercepter les requêtes non-GET.
     * Cela protège les écritures, modifications et suppressions.
     */
    if (request.method !== "GET") {
        return;
    }

    /*
     * Les requêtes partielles ne sont pas mises en cache.
     */
    if (request.headers.has("range")) {
        return;
    }

    let url;

    try {
        url = new URL(request.url);
    } catch (error) {
        return;
    }

    if (
        url.protocol !== "https:" &&
        url.protocol !== "http:"
    ) {
        return;
    }

    /*
     * EXCLUSION ABSOLUE DE SUPABASE :
     * authentification, API REST, données métier et Realtime.
     *
     * Ces requêtes sont laissées au navigateur et au client
     * Supabase, sans cache ni réponse fabriquée par ce SW.
     */
    if (isSupabaseRequest(url)) {
        return;
    }

    /*
     * Navigation : uniquement dans la portée de l'application.
     */
    if (request.mode === "navigate") {
        if (
            isSameOrigin(url) &&
            url.href.startsWith(self.registration.scope)
        ) {
            event.respondWith(handleNavigation(request));
        }
        return;
    }

    /*
     * Ressources externes telles que les bibliothèques JS.
     */
    if (isVendorRequest(url)) {
        event.respondWith(handleVendorRequest(request));
        return;
    }

    /*
     * Fichiers locaux de l'application uniquement.
     */
    if (isSameOrigin(url)) {
        event.respondWith(handleStaticRequest(request));
    }
});

/* ------------------------------------------------------------
   MESSAGES DE DIAGNOSTIC
   ------------------------------------------------------------ */

self.addEventListener("message", event => {
    const message = event.data;

    if (!message || typeof message !== "object") {
        return;
    }

    if (message.type === "GET_SW_VERSION") {
        if (event.ports && event.ports[0]) {
            event.ports[0].postMessage({
                version: SW_VERSION,
                appCache: APP_CACHE,
                runtimeCache: RUNTIME_CACHE
            });
        }
    }

    if (message.type === "SKIP_WAITING") {
        event.waitUntil(self.skipWaiting());
    }
});
               
