/* ============================================================
   SCAN MGV LIVE — SERVICE WORKER
   Version : 12.0.0

   Fonctionnalités :
   - Cache de l'application
   - Cache des bibliothèques du scanner
   - Chargement local prioritaire
   - Secours CDN
   - Fonctionnement hors ligne
   - Mise à jour contrôlée des caches
   - Protection des communications Supabase
   ============================================================ */

"use strict";

/* ============================================================
   1. CONFIGURATION
   ============================================================ */

const SW_VERSION = "12.0.0";

const APP_CACHE = "scan-qr-app-v12";
const RUNTIME_CACHE = "scan-qr-runtime-v12";

const CACHE_PREFIX = "scan-qr-";

const REQUEST_TIMEOUT_LOCAL = 5000;
const REQUEST_TIMEOUT_CDN = 12000;

/*
 * Ressources locales de l'application.
 *
 * Les chemins sont relatifs au dossier dans lequel
 * service-worker.js est installé.
 */

const APP_SHELL = [
    "./",
    "./index.html",
    "./manifest.json",
    "./IMG_20260413_130653.png"
];

/*
 * Bibliothèques utilisées par le scanner.
 *
 * Si le fichier local est absent, le Service Worker
 * tente de télécharger la bibliothèque depuis son CDN.
 */

const VENDOR_RESOURCES = [
    {
        localPath: "./vendor/html5-qrcode.min.js",
        cdnURL: "https://unpkg.com/html5-qrcode"
    },
    {
        localPath: "./vendor/supabase.min.js",
        cdnURL:
            "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"
    }
];


/* ============================================================
   2. OUTILS
   ============================================================ */

/*
 * Construit une URL absolue à partir d'un chemin local.
 */

function appURL(path) {
    return new URL(path, self.registration.scope).href;
}


/*
 * Vérifie qu'une réponse peut être mise en cache.
 *
 * Les réponses opaques, les erreurs HTTP et les réponses
 * provenant d'une requête interrompue sont refusées.
 */

function isValidResource(response) {
    if (!response) {
        return false;
    }

    if (!response.ok) {
        return false;
    }

    if (response.type === "opaque") {
        return false;
    }

    if (response.type === "error") {
        return false;
    }

    if (response.status === 206) {
        return false;
    }

    if (response.status !== 200) {
        return false;
    }

    return true;
}


/*
 * Téléchargement avec délai maximal.
 *
 * AbortController permet d'interrompre une requête
 * lorsque le délai est dépassé.
 */

async function fetchWithTimeout(request, timeoutMs) {
    const controller = new AbortController();

    const timer = setTimeout(() => {
        controller.abort();
    }, timeoutMs);

    try {
        const response = await fetch(request, {
            signal: controller.signal
        });

        return response;
    } finally {
        clearTimeout(timer);
    }
}


/*
 * Vérifie qu'une URL appartient au périmètre
 * de l'application.
 */

function isSameOrigin(url) {
    return url.origin === self.location.origin;
}


/*
 * Identifie les communications dynamiques Supabase.
 *
 * Ces communications ne doivent pas être traitées
 * comme des ressources statiques de l'application.
 */

function isSupabaseRequest(url) {
    const hostname = url.hostname.toLowerCase();

    return (
        hostname === "supabase.co" ||
        hostname.endsWith(".supabase.co") ||
        hostname === "supabase.com" ||
        hostname.endsWith(".supabase.com")
    );
}


/*
 * Identifie les bibliothèques téléchargées depuis
 * les CDN autorisés.
 */

function isVendorCDN(url) {
    return (
        url.origin === "https://unpkg.com" ||
        url.origin === "https://cdn.jsdelivr.net"
    );
}


/*
 * Vérifie qu'une requête peut être mise en cache.
 *
 * Les requêtes POST, PUT, PATCH, DELETE et autres
 * méthodes non GET ne sont jamais mises en cache.
 */

function isCacheableRequest(request) {
    return (
        request.method === "GET" &&
        request.headers.get("range") === null
    );
}


/* ============================================================
   3. MISE EN CACHE D'UNE BIBLIOTHÈQUE
   ============================================================ */

/*
 * Stratégie :
 *
 * 1. Chercher le fichier local.
 * 2. Si le fichier local est absent ou invalide,
 *    essayer le CDN.
 * 3. Enregistrer la ressource sous son URL locale.
 * 4. Enregistrer également la ressource sous son URL CDN.
 *
 * Cette double mise en cache permet de réutiliser
 * une bibliothèque déjà téléchargée.
 */

async function cacheVendor(cache, localPath, cdnURL) {
    const localURL = appURL(localPath);

    /*
     * 1. Essayer d'abord le fichier local.
     */

    try {
        const localResponse = await fetchWithTimeout(
            new Request(localURL, {
                cache: "reload"
            }),
            REQUEST_TIMEOUT_LOCAL
        );

        if (isValidResource(localResponse)) {
            await cache.put(
                localURL,
                localResponse.clone()
            );

            console.info(
                "[SCAN-QR SW] Bibliothèque locale mise en cache :",
                localPath
            );

            return true;
        }
    } catch (error) {
        console.warn(
            "[SCAN-QR SW] Fichier local indisponible :",
            localPath
        );
    }

    /*
     * 2. Essayer le CDN.
     */

    try {
        const response = await fetchWithTimeout(
            new Request(cdnURL, {
                mode: "cors",
                credentials: "omit"
            }),
            REQUEST_TIMEOUT_CDN
        );

        if (!isValidResource(response)) {
            console.warn(
                "[SCAN-QR SW] Réponse CDN invalide :",
                cdnURL
            );

            return false;
        }

        /*
         * 3. Enregistrer la bibliothèque sous son URL locale.
         */

        await cache.put(
            localURL,
            response.clone()
        );

        /*
         * 4. Enregistrer la bibliothèque sous son URL CDN.
         */

        const runtimeCache = await caches.open(
            RUNTIME_CACHE
        );

        await runtimeCache.put(
            cdnURL,
            response.clone()
        );

        console.info(
            "[SCAN-QR SW] Bibliothèque CDN mise en cache :",
            cdnURL
        );

        return true;

    } catch (error) {
        console.error(
            "[SCAN-QR SW] Échec de mise en cache :",
            cdnURL,
            error
        );

        return false;
    }
}


/* ============================================================
   4. INSTALLATION
   ============================================================ */

self.addEventListener("install", event => {
    event.waitUntil(
        (async () => {
            console.info(
                "[SCAN-QR SW] Installation :",
                SW_VERSION
            );

            const appCache = await caches.open(APP_CACHE);

            /*
             * Mise en cache des ressources principales.
             *
             * Chaque ressource est traitée séparément pour
             * éviter qu'un seul fichier absent bloque
             * l'ensemble de l'installation.
             */

            const shellResults = await Promise.allSettled(
                APP_SHELL.map(async path => {
                    const url = appURL(path);

                    const response = await fetchWithTimeout(
                        new Request(url, {
                            cache: "reload"
                        }),
                        REQUEST_TIMEOUT_LOCAL
                    );

                    if (!isValidResource(response)) {
                        throw new Error(
                            "Ressource invalide : " + url
                        );
                    }

                    await appCache.put(
                        url,
                        response.clone()
                    );

                    return url;
                })
            );

            shellResults.forEach((result, index) => {
                if (result.status === "rejected") {
                    console.warn(
                        "[SCAN-QR SW] Ressource non mise en cache :",
                        APP_SHELL[index],
                        result.reason
                    );
                }
            });

            /*
             * Mise en cache des bibliothèques.
             *
             * L'échec d'une bibliothèque ne bloque pas
             * l'installation du Service Worker.
             */

            const vendorResults = await Promise.allSettled(
                VENDOR_RESOURCES.map(resource =>
                    cacheVendor(
                        appCache,
                        resource.localPath,
                        resource.cdnURL
                    )
                )
            );

            vendorResults.forEach((result, index) => {
                if (result.status === "rejected") {
                    console.warn(
                        "[SCAN-QR SW] Bibliothèque non disponible :",
                        VENDOR_RESOURCES[index].localPath,
                        result.reason
                    );
                }
            });

            /*
             * Activation immédiate de cette version.
             */

            await self.skipWaiting();

            console.info(
                "[SCAN-QR SW] Installation terminée."
            );
        })()
    );
});


/* ============================================================
   5. ACTIVATION
   ============================================================ */

self.addEventListener("activate", event => {
    event.waitUntil(
        (async () => {
            console.info(
                "[SCAN-QR SW] Activation :",
                SW_VERSION
            );

            /*
             * Supprimer uniquement les anciens caches
             * appartenant à cette application.
             *
             * Les autres caches du navigateur sont préservés.
             */

            const cacheNames = await caches.keys();

            await Promise.all(
                cacheNames.map(async cacheName => {
                    const isOldAppCache =
                        cacheName.startsWith(CACHE_PREFIX) &&
                        cacheName !== APP_CACHE &&
                        cacheName !== RUNTIME_CACHE;

                    if (isOldAppCache) {
                        await caches.delete(cacheName);

                        console.info(
                            "[SCAN-QR SW] Ancien cache supprimé :",
                            cacheName
                        );
                    }
                })
            );

            /*
             * Prendre en charge les pages déjà ouvertes.
             */

            await self.clients.claim();

            console.info(
                "[SCAN-QR SW] Application prête."
            );
        })()
    );
});


/* ============================================================
   6. RECHERCHE D'UNE RESSOURCE DANS LE CACHE
   ============================================================ */

async function findCachedResource(request, url) {
    /*
     * Rechercher d'abord une correspondance exacte.
     */

    const exactResponse = await caches.match(request);

    if (exactResponse) {
        return exactResponse;
    }

    /*
     * Rechercher ensuite l'URL absolue.
     */

    const absoluteResponse = await caches.match(url.href);

    if (absoluteResponse) {
        return absoluteResponse;
    }

    return null;
}


/* ============================================================
   7. RESSOURCES STATIQUES DE L'APPLICATION
   ============================================================ */

/*
 * Stratégie Cache First :
 *
 * - Si la ressource existe dans le cache, la retourner.
 * - Sinon, essayer le réseau.
 * - Si la réponse est valide, l'enregistrer.
 * - Si le réseau échoue, rechercher une ressource de secours.
 */

async function handleStaticRequest(request, url) {
    const cachedResponse = await findCachedResource(
        request,
        url
    );

    if (cachedResponse) {
        return cachedResponse;
    }

    try {
        const response = await fetch(request);

        if (!isValidResource(response)) {
            return response;
        }

        /*
         * Ne mettre en cache que les ressources de
         * même origine.
         */

        if (isSameOrigin(url)) {
            const cache = await caches.open(APP_CACHE);

            await cache.put(
                request,
                response.clone()
            ).catch(error => {
                console.warn(
                    "[SCAN-QR SW] Impossible de mettre en cache :",
                    url.href,
                    error
                );
            });
        }

        return response;

    } catch (error) {
        /*
         * Une ressource statique inconnue ne doit pas
         * provoquer une fausse réponse HTML.
         */

        return new Response(
            "Ressource indisponible hors ligne.",
            {
                status: 503,
                statusText: "Service Unavailable",
                headers: {
                    "Content-Type": "text/plain; charset=utf-8"
                }
            }
        );
    }
}


/* ============================================================
   8. NAVIGATION ET PAGE HORS LIGNE
   ============================================================ */

/*
 * Stratégie Network First :
 *
 * - Essayer de charger la page depuis le réseau.
 * - En cas d'échec, utiliser la version en cache.
 * - Ne jamais mettre en cache les données Supabase
 *   via cette stratégie.
 */

async function handleNavigation(request) {
    try {
        const response = await fetch(request);

        if (isValidResource(response)) {
            const cache = await caches.open(APP_CACHE);

            await cache.put(
                appURL("./index.html"),
                response.clone()
            ).catch(error => {
                console.warn(
                    "[SCAN-QR SW] Mise à jour du cache HTML impossible :",
                    error
                );
            });
        }

        return response;

    } catch (error) {
        const cachedPage = await caches.match(
            appURL("./index.html")
        );

        if (cachedPage) {
            return cachedPage;
        }

        return new Response(
            `<!DOCTYPE html>
            <html lang="fr">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport"
                      content="width=device-width, initial-scale=1">
                <title>SCAN MGV LIVE</title>
                <style>
                    body {
                        margin: 0;
                        padding: 30px;
                        background: #131313;
                        color: #eaea00;
                        font-family: Arial, sans-serif;
                        text-align: center;
                    }
                    p {
                        color: #ffffff;
                        line-height: 1.6;
                    }
                </style>
            </head>
            <body>
                <h2>SCAN MGV LIVE</h2>
                <p>
                    La page principale n'est pas disponible
                    dans le cache.
                </p>
                <p>
                    Reconnectez-vous à Internet puis rechargez
                    l'application.
                </p>
            </body>
            </html>`,
            {
                status: 503,
                headers: {
                    "Content-Type": "text/html; charset=utf-8"
                }
            }
        );
    }
}


/* ============================================================
   9. BIBLIOTHÈQUES CDN
   ============================================================ */

/*
 * Les scripts CDN peuvent être servis depuis le cache
 * lorsqu'ils ont été téléchargés précédemment.
 *
 * En l'absence de cache, une requête réseau est tentée.
 */

async function handleVendorRequest(request, url) {
    const runtimeCache = await caches.open(RUNTIME_CACHE);

    /*
     * Rechercher d'abord l'URL CDN exacte.
     */

    const cachedResponse = await runtimeCache.match(
        request
    );

    if (cachedResponse) {
        return cachedResponse;
    }

    try {
        const response = await fetch(request);

        if (!isValidResource(response)) {
            return response;
        }

        await runtimeCache.put(
            request,
            response.clone()
        ).catch(error => {
            console.warn(
                "[SCAN-QR SW] Cache CDN indisponible :",
                url.href,
                error
            );
        });

        return response;

    } catch (error) {
        /*
         * La bibliothèque peut avoir été enregistrée
         * sous un chemin local.
         */

        const vendor = VENDOR_RESOURCES.find(
            resource => resource.cdnURL === url.href
        );

        if (vendor) {
            const localURL = appURL(vendor.localPath);

            const localResponse = await caches.match(
                localURL
            );

            if (localResponse) {
                return localResponse;
            }
        }

        return new Response(
            "Bibliothèque indisponible hors ligne.",
            {
                status: 503,
                headers: {
                    "Content-Type": "text/plain; charset=utf-8"
                }
            }
        );
    }
}


/* ============================================================
   10. INTERCEPTION DES REQUÊTES
   ============================================================ */

self.addEventListener("fetch", event => {
    const request = event.request;

    /*
     * Ne jamais intercepter les méthodes d'écriture.
     *
     * Les opérations INSERT, UPDATE, PATCH et DELETE
     * doivent conserver leur fonctionnement normal.
     */

    if (!isCacheableRequest(request)) {
        return;
    }

    let url;

    try {
        url = new URL(request.url);
    } catch (error) {
        return;
    }

    /*
     * Ne pas intercepter les protocoles autres que HTTP(S).
     */

    if (
        url.protocol !== "http:" &&
        url.protocol !== "https:"
    ) {
        return;
    }

    /*
     * Ne jamais mettre en cache les communications
     * dynamiques Supabase :
     *
     * REST, Auth, Realtime, Storage et fonctions API.
     *
     * Le réseau et la logique existante de synchronisation
     * restent responsables de ces communications.
     */

    if (isSupabaseRequest(url)) {
        return;
    }

    /*
     * 1. Navigation vers une page.
     */

    if (request.mode === "navigate") {
        event.respondWith(
            handleNavigation(request)
        );

        return;
    }

    /*
     * 2. Bibliothèques provenant des CDN autorisés.
     */

    if (isVendorCDN(url)) {
        const isKnownVendor = VENDOR_RESOURCES.some(
            resource => resource.cdnURL === url.href
        );

        if (isKnownVendor) {
            event.respondWith(
                handleVendorRequest(request, url)
            );
        }

        return;
    }

    /*
     * 3. Ressources statiques locales.
     *
     * Les ressources externes inconnues ne sont pas
     * interceptées.
     */

    if (isSameOrigin(url)) {
        event.respondWith(
            handleStaticRequest(request, url)
        );
    }
});


/* ============================================================
   11. MESSAGES DE DIAGNOSTIC
   ============================================================ */

    self.addEventListener("message", event => {
    const message = event.data;

    if (!message || typeof message !== "object") {
        return;
    }

    /*
     * Permet à la page de demander la version du SW.
     */

    if (message.type === "GET_SW_VERSION") {
        if (event.ports && event.ports[0]) {
            event.ports[0].postMessage({
                version: SW_VERSION,
                appCache: APP_CACHE,
                runtimeCache: RUNTIME_CACHE
            });
        }
    }

    /*
     * Permet de demander une activation immédiate.
     */

    if (message.type === "SKIP_WAITING") {
        event.waitUntil(
            self.skipWaiting()
        );
    }
});


/* ============================================================
   12. FIN DU SERVICE WORKER
   ============================================================ */

console.info(
    "[SCAN-QR SW] Service Worker chargé :",
    SW_VERSION
);
