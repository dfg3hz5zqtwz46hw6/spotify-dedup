import PromiseThrottle from 'promise-throttle';
import OAuthManager from './oauth-manager';
import { PlaylistDeduplicator, SavedTracksDeduplicator } from './deduplicator';
import fetch from './custom-fetch';

import mainCss from '../styles/main.css';
import customCss from '../styles/custom.css';
import favicon from '../favicon.ico';

const retryOnCodes = [400, 401, 404, 429, 500, 502, 503, 504];
class PlaylistCache {
  needsCheckForDuplicates(playlist) {
    if ('snapshot_id' in playlist) {
      try {
        if (localStorage.getItem(playlist.snapshot_id) === '0') {
          return false;
        }
      } catch (e) {
        return true;
      }
    }
    return true;
  }

  storePlaylistWithoutDuplicates(playlist) {
    if ('snapshot_id' in playlist) {
      try {
        localStorage.setItem(playlist.snapshot_id, '0');
      } catch (e) {}
    }
  }
}

const playlistCache = new PlaylistCache();

const apiPrefix = 'https://api.spotify.com/v1';

class SpotifyWebApi {
  constructor() {
    this.token = null;
  }

  setAccessToken(token) {
    this.token = token;
  }

  async getMe() {
    return await this.getGeneric(`${apiPrefix}/me`);
  }

  async getGeneric(url, options) {
    const optionsString =
      options === undefined
        ? ''
        : `?${Object.keys(options)
            .map(k => `${k}=${options[k]}`)
            .join('&')}`;

    const res = await fetch(`${url}${optionsString}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.token}`
      },
      retryOn: retryOnCodes
    });
    const json = await res.json();
    if (res.ok) return json;
    return null;
  }

  async getUserPlaylists(userId, options) {
    const url =
      typeof userId === 'string'
        ? `${apiPrefix}/users/${encodeURIComponent(userId)}/playlists`
        : `${apiPrefix}/me/playlists`;
    return await this.getGeneric(url, options);
  }

  async removeTracksFromPlaylist(userId, playlistId, uris) {
    const dataToBeSent = {
      tracks: uris.map(uri => (typeof uri === 'string' ? { uri: uri } : uri))
    };

    const res = await fetch(
      `${apiPrefix}/users/${encodeURIComponent(
        userId
      )}/playlists/${playlistId}/tracks`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${this.token}`
        },
        body: JSON.stringify(dataToBeSent),
        retryOn: retryOnCodes
      }
    );

    const json = await res.json();
    if (res.ok) {
      return json;
    } else {
      global.Raven &&
        Raven.captureMessage(
          `Status ${res.status} when deleting tracks from playlist`,
          {
            extra: {
              json: json
            }
          }
        );
    }
    return null;
  }

  async getMySavedTracks(options) {
    return this.getGeneric(`${apiPrefix}/me/tracks`, options);
  }

  async removeFromMySavedTracks(trackIds) {
    const res = await fetch(`${apiPrefix}/me/tracks`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${this.token}`
      },
      body: JSON.stringify(trackIds),
      retryOn: retryOnCodes
    });

    if (res.ok) return true;
    return false;
  }
}

const init = function() {
  let playlistDeduplicator;
  let savedTracksDeduplicator;

  let token, api;

  let app = new Vue({
    el: '#app',
    data: {
      isLoggedIn: false,
      toProcess: 100,
      playlists: [],
      savedTracks: {
        duplicates: [],
        status: ''
      }
    },
    methods: {
      removeDuplicates: playlistModel =>
        (async () => {
          if (playlistModel.playlist.id === 'starred') {
            global.alert(
              'It is not possible to delete duplicates from your Starred playlist using this tool since this is not supported in the Spotify Web API. You will need to remove these manually.'
            );
          }
          if (playlistModel.playlist.collaborative) {
            global.alert(
              'It is not possible to delete duplicates from a collaborative playlist using this tool since this is not supported in the Spotify Web API. You will need to remove these manually.'
            );
          } else {
            try {
              const duplicates = await playlistDeduplicator.removeDuplicates(
                playlistModel
              );
              playlistModel.duplicates = [];
              playlistModel.status = 'Duplicates removed';
              if (global.ga) {
                ga(
                  'send',
                  'event',
                  'spotify-dedup',
                  'playlist-removed-duplicates'
                );
              }
            } catch (e) {
              global.Raven &&
                Raven.captureMessage(
                  `Exception trying to remove duplicates from playlist`,
                  {
                    extra: {
                      duplicates: playlistModel.duplicates
                    }
                  }
                );
            }
          }
        })(),
      removeDuplicatesInSavedTracks: () =>
        (async () => {
          const duplicates = await savedTracksDeduplicator.removeDuplicates(
            app.savedTracks
          );
          app.savedTracks.duplicates = [];
          app.savedTracks.status = 'Duplicates removed';
          if (global.ga) {
            ga(
              'send',
              'event',
              'spotify-dedup',
              'saved-tracks-removed-duplicates'
            );
          }
        })()
    },
    computed: {
      duplicates: function() {
        return (
          this.playlists.reduce(
            (prev, current) => prev + current.duplicates.length,
            0
          ) + this.savedTracks.duplicates.length
        );
      }
    }
  });

  document.getElementById('login').addEventListener('click', function() {
    OAuthManager.obtainToken({
      scopes: [
        /*
          the permission for reading public playlists is granted
          automatically when obtaining an access token through
          the user login form
          */
        'playlist-read-private',
        'playlist-read-collaborative',
        'playlist-modify-public',
        'playlist-modify-private',
        'user-library-read',
        'user-library-modify'
      ]
    })
      .then(function(token) {
        onTokenReceived(token);
      })
      .catch(function(error) {
        console.error(error);
      });
    // });

    function fetchUserOwnedPlaylists(user) {
      return promisesForPages(api.getUserPlaylists(user, { limit: 50 })).then(
        function(pages) {
          // combine and filter playlists
          var userOwnedPlaylists = [];
          pages.forEach(function(page) {
            userOwnedPlaylists = userOwnedPlaylists.concat(
              page.items.filter(function(playlist) {
                return playlist.owner.id === user;
              })
            );
          });
          return userOwnedPlaylists;
        }
      );
    }

    function onPlaylistProcessed(playlist) {
      playlist.processed = true;
      var remaining = app.toProcess - 1;
      app.toProcess -= 1;
      if (remaining === 0 && global.ga) {
        ga('send', 'event', 'spotify-dedup', 'library-processed');
      }
    }

    const playlistToPlaylistModel = playlist => ({
      playlist: playlist,
      duplicates: [],
      status: '',
      processed: false
    });

    async function onUserDataFetched(data) {
      var user = data.id,
        playlistsToCheck = [];

      const ownedPlaylists = await fetchUserOwnedPlaylists(user);
      playlistsToCheck = ownedPlaylists;
      app.playlists = playlistsToCheck.map(p => playlistToPlaylistModel(p));
      app.toProcess = app.playlists.length + 1 /* saved tracks */;
      const savedTracks = await savedTracksDeduplicator.getTracks(
        api.getMySavedTracks({ limit: 50 })
      );
      app.savedTracks.duplicates = savedTracksDeduplicator.findDuplicatedTracks(
        savedTracks
      );
      if (app.savedTracks.duplicates.length && global.ga) {
        ga('send', 'event', 'spotify-dedup', 'saved-tracks-found-duplicates');
      }
      app.toProcess--;

      app.playlists.forEach(playlistModel =>
        (async () => {
          if (playlistCache.needsCheckForDuplicates(playlistModel.playlist)) {
            const playlistTracks = await playlistDeduplicator.getTracks(
              playlistModel.playlist
            );
            playlistModel.duplicates = playlistDeduplicator.findDuplicatedTracks(
              playlistTracks
            );
            if (playlistModel.duplicates.length === 0) {
              playlistCache.storePlaylistWithoutDuplicates(
                playlistModel.playlist
              );
            }
          }
          onPlaylistProcessed(playlistModel.playlist);
        })()
      );
    }

    function onTokenReceived(accessToken) {
      app.isLoggedIn = true;
      api = new SpotifyWebApi();
      api.setAccessToken(accessToken);

      playlistDeduplicator = new PlaylistDeduplicator(api);
      savedTracksDeduplicator = new SavedTracksDeduplicator(api);

      let attempts = 0;
      const loginFunction = () => {
        return api.getMe().then(data => {
          if (data === null) {
            attempts++;
            global.Raven &&
              Raven.captureMessage(`Retrying logging user in`, {
                extra: {
                  attempts: attempts
                }
              });
            loginFunction();
          } else {
            (async () => {
              await onUserDataFetched(data);
            })();
          }
        });
      };
      loginFunction();
    }

    async function promisesForPages(initialRequest) {
      console.log('promisesForPages!');
      function stripParameters(href) {
        var u = new URL(href);
        return u.origin + u.pathname;
      }

      function fetchGeneric(results, offset, limit) {
        return api.getGeneric(
          stripParameters(results.href) +
            '?offset=' +
            offset +
            '&limit=' +
            limit
        );
      }

      console.log(initialRequest);
      const results = await initialRequest;
      console.log('got initial request', results);
      if (results === null) {
        return [];
      }
      const promises = [() => initialRequest];
      let offset = results.limit + results.offset;
      const limit = results.limit;
      while (results.total > offset) {
        (function(results, offset, limit) {
          const q = () => fetchGeneric(results, offset, limit);
          promises.push(q);
        })(results, offset, limit);
        offset += limit;
      }

      console.log(promises[0]());
      return promises.reduce(
        (promise, func) =>
          promise.then(result => {
            console.log('executing', func);
            return func().then(Array.prototype.concat.bind(result));
          }),
        Promise.resolve([])
      );
    }
  });
};

global.Raven &&
  Raven.config(
    'https://22cbac299caf4962b74de18bc87a8d74@sentry.io/1239123'
  ).install();

if (global.Raven) {
  Raven.context(init);
} else {
  init();
}
