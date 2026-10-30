/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/copy_vault.json`.
 */
export type CopyVault = {
  "address": "9R8g8JtEqRAh5yZ4aXbf1mWcfgLq9kAo6fmx93MSK9k7",
  "metadata": {
    "name": "copyVault",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "copy-vault: pump.fun coins whose creator fees fund an on-chain vault that copy-trades a target wallet"
  },
  "instructions": [
    {
      "name": "acceptAdmin",
      "docs": [
        "The proposed admin takes over, after the timelock."
      ],
      "discriminator": [
        112,
        42,
        45,
        90,
        116,
        181,
        13,
        170
      ],
      "accounts": [
        {
          "name": "pendingAdmin",
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "burnPlatform",
      "discriminator": [
        140,
        172,
        140,
        172,
        12,
        84,
        147,
        195
      ],
      "accounts": [
        {
          "name": "keeper",
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "burnPool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109,
                  45,
                  98,
                  117,
                  114,
                  110
                ]
              }
            ]
          }
        },
        {
          "name": "platformMint",
          "writable": true
        },
        {
          "name": "burnPoolTokenAccount",
          "writable": true
        },
        {
          "name": "burnPoolWsol",
          "writable": true
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "quoteTokenProgram"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "instructions",
          "address": "Sysvar1nstructions1111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "descriptorIdx",
          "type": "u8"
        },
        {
          "name": "solIn",
          "type": "u64"
        },
        {
          "name": "minTokensOut",
          "type": "u64"
        },
        {
          "name": "ixData",
          "type": "bytes"
        }
      ]
    },
    {
      "name": "buybackBurn",
      "discriminator": [
        20,
        254,
        58,
        252,
        209,
        32,
        111,
        97
      ],
      "accounts": [
        {
          "name": "keeper",
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "copier",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  112,
                  105,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "mint",
          "writable": true
        },
        {
          "name": "vaultTokenAccount",
          "writable": true
        },
        {
          "name": "vaultWsol",
          "writable": true
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "quoteTokenProgram"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "instructions",
          "address": "Sysvar1nstructions1111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "descriptorIdx",
          "type": "u8"
        },
        {
          "name": "solIn",
          "type": "u64"
        },
        {
          "name": "minTokensOut",
          "type": "u64"
        },
        {
          "name": "ixData",
          "type": "bytes"
        }
      ]
    },
    {
      "name": "cancelPending",
      "discriminator": [
        74,
        87,
        109,
        242,
        64,
        192,
        151,
        71
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "pending",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  110,
                  100,
                  105,
                  110,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "pending.id",
                "account": "pendingChange"
              }
            ]
          }
        },
        {
          "name": "proposer",
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "copierBuy",
      "discriminator": [
        83,
        192,
        185,
        38,
        57,
        16,
        44,
        161
      ],
      "accounts": [
        {
          "name": "keeper",
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "copier",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  112,
                  105,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "copier.mint",
                "account": "copier"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "copier.mint",
                "account": "copier"
              }
            ]
          }
        },
        {
          "name": "tokenMint"
        },
        {
          "name": "position",
          "docs": [
            "bump once it exists); created by the program on the first buy."
          ],
          "writable": true
        },
        {
          "name": "target"
        },
        {
          "name": "targetTokenAccount"
        },
        {
          "name": "vaultTokenAccount",
          "writable": true
        },
        {
          "name": "vaultWsol",
          "writable": true
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "quoteTokenProgram"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "instructions",
          "address": "Sysvar1nstructions1111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "targetIdx",
          "type": "u8"
        },
        {
          "name": "descriptorIdx",
          "type": "u8"
        },
        {
          "name": "solIn",
          "type": "u64"
        },
        {
          "name": "minTokensOut",
          "type": "u64"
        },
        {
          "name": "ixData",
          "type": "bytes"
        }
      ]
    },
    {
      "name": "copierSell",
      "discriminator": [
        17,
        59,
        238,
        145,
        167,
        85,
        194,
        180
      ],
      "accounts": [
        {
          "name": "authority",
          "docs": [
            "The keeper, or anyone once the keeper heartbeat is older than `keeper_grace_secs` and the",
            "target holds 0 (then in impact-capped slices, one per slot)."
          ],
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "copier",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  112,
                  105,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "copier.mint",
                "account": "copier"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "copier.mint",
                "account": "copier"
              }
            ]
          }
        },
        {
          "name": "burnPool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109,
                  45,
                  98,
                  117,
                  114,
                  110
                ]
              }
            ]
          }
        },
        {
          "name": "tokenMint"
        },
        {
          "name": "position",
          "docs": [
            "`[\"position\", copier.mint, token_mint]`: the open position being sold."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "copier.mint",
                "account": "copier"
              },
              {
                "kind": "account",
                "path": "tokenMint"
              }
            ]
          }
        },
        {
          "name": "target"
        },
        {
          "name": "targetTokenAccount"
        },
        {
          "name": "vaultTokenAccount",
          "writable": true
        },
        {
          "name": "vaultWsol",
          "writable": true
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "quoteTokenProgram"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "instructions",
          "address": "Sysvar1nstructions1111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "targetIdx",
          "type": "u8"
        },
        {
          "name": "descriptorIdx",
          "type": "u8"
        },
        {
          "name": "tokensIn",
          "type": "u64"
        },
        {
          "name": "minSolOut",
          "type": "u64"
        },
        {
          "name": "ixData",
          "type": "bytes"
        }
      ]
    },
    {
      "name": "deposit",
      "docs": [
        "Anyone adds capital (not profit) to a vault."
      ],
      "discriminator": [
        242,
        35,
        198,
        137,
        82,
        225,
        242,
        182
      ],
      "accounts": [
        {
          "name": "depositor",
          "writable": true,
          "signer": true
        },
        {
          "name": "copier",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  112,
                  105,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "copier.mint",
                "account": "copier"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "copier.mint",
                "account": "copier"
              }
            ]
          }
        },
        {
          "name": "vaultWsol"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "lamports",
          "type": "u64"
        }
      ]
    },
    {
      "name": "discardPending",
      "docs": [
        "Anyone closes a superseded or expired change (rent to its proposer)."
      ],
      "discriminator": [
        35,
        68,
        11,
        2,
        188,
        246,
        152,
        253
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "pending",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  110,
                  100,
                  105,
                  110,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "pending.id",
                "account": "pendingChange"
              }
            ]
          }
        },
        {
          "name": "proposer",
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "executePending",
      "docs": [
        "Anyone, once the change's timelock has passed."
      ],
      "discriminator": [
        207,
        36,
        5,
        220,
        230,
        106,
        57,
        181
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "pending",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  110,
                  100,
                  105,
                  110,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "pending.id",
                "account": "pendingChange"
              }
            ]
          }
        },
        {
          "name": "proposer",
          "writable": true
        },
        {
          "name": "copier",
          "docs": [
            "The Index copier of an `IndexTargets` change (omit for other kinds)."
          ],
          "writable": true,
          "optional": true
        }
      ],
      "args": []
    },
    {
      "name": "fundPlatformBurn",
      "docs": [
        "Moves the copier's pending 25% profit share to the platform token burn pool."
      ],
      "discriminator": [
        163,
        119,
        190,
        132,
        133,
        239,
        18,
        184
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "copier",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  112,
                  105,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "copier.mint",
                "account": "copier"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "copier.mint",
                "account": "copier"
              }
            ]
          }
        },
        {
          "name": "vaultWsol"
        },
        {
          "name": "burnPool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109,
                  45,
                  98,
                  117,
                  114,
                  110
                ]
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "initializeConfig",
      "docs": [
        "Once, by the program's upgrade authority: default params, the seeded venue whitelist, the",
        "admin timelock (60 s – 7 days) and the funded platform-token burn pool."
      ],
      "discriminator": [
        208,
        127,
        21,
        1,
        194,
        190,
        196,
        70
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "programData",
          "docs": [
            "The program's ProgramData: only its upgrade authority (the deployer) can initialize."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  125,
                  12,
                  28,
                  205,
                  133,
                  182,
                  44,
                  161,
                  225,
                  95,
                  131,
                  126,
                  85,
                  160,
                  64,
                  82,
                  79,
                  32,
                  131,
                  171,
                  39,
                  132,
                  9,
                  104,
                  152,
                  169,
                  12,
                  152,
                  164,
                  30,
                  176,
                  68
                ]
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                2,
                168,
                246,
                145,
                78,
                136,
                161,
                176,
                226,
                16,
                21,
                62,
                247,
                99,
                174,
                43,
                0,
                194,
                185,
                61,
                22,
                193,
                36,
                210,
                192,
                83,
                122,
                16,
                4,
                128,
                0,
                0
              ]
            }
          }
        },
        {
          "name": "burnPool",
          "docs": [
            "the platform token burn pool: system-owned, zero data; funded to rent here so it can receive any share."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109,
                  45,
                  98,
                  117,
                  114,
                  110
                ]
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "keeper",
          "type": "pubkey"
        },
        {
          "name": "timelockSecs",
          "type": "i64"
        }
      ]
    },
    {
      "name": "keeperHeartbeat",
      "docs": [
        "The keeper's liveness signal (every keeper-signed trade or burn also counts)."
      ],
      "discriminator": [
        144,
        217,
        237,
        161,
        10,
        157,
        34,
        96
      ],
      "accounts": [
        {
          "name": "keeper",
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "pauseKeeper",
      "docs": [
        "Instant: removes the keeper."
      ],
      "discriminator": [
        155,
        213,
        197,
        244,
        116,
        255,
        251,
        45
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "proposeAdmin",
      "discriminator": [
        121,
        214,
        199,
        212,
        87,
        39,
        117,
        234
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "newAdmin",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "proposeDescriptors",
      "docs": [
        "Queues a venue whitelist change."
      ],
      "discriminator": [
        231,
        129,
        42,
        155,
        159,
        63,
        174,
        125
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "pending",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  110,
                  100,
                  105,
                  110,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "config.next_change_id",
                "account": "config"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "descriptors",
          "type": {
            "vec": {
              "defined": {
                "name": "tradeDescriptor"
              }
            }
          }
        }
      ]
    },
    {
      "name": "proposeIndexTargets",
      "docs": [
        "Queues an Index copier's new target list."
      ],
      "discriminator": [
        1,
        96,
        144,
        18,
        108,
        73,
        224,
        19
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "copier",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  112,
                  105,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "copier.mint",
                "account": "copier"
              }
            ]
          }
        },
        {
          "name": "pending",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  110,
                  100,
                  105,
                  110,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "config.next_change_id",
                "account": "config"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "targets",
          "type": {
            "vec": "pubkey"
          }
        }
      ]
    },
    {
      "name": "proposeKeeper",
      "docs": [
        "Queues a keeper change (executable after the timelock)."
      ],
      "discriminator": [
        35,
        219,
        88,
        80,
        36,
        86,
        9,
        93
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "pending",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  110,
                  100,
                  105,
                  110,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "config.next_change_id",
                "account": "config"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "keeper",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "proposeParams",
      "docs": [
        "Queues a parameter change (validated against the ranges now and at execution)."
      ],
      "discriminator": [
        94,
        141,
        220,
        182,
        171,
        53,
        52,
        182
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "pending",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  110,
                  100,
                  105,
                  110,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "config.next_change_id",
                "account": "config"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "params"
            }
          }
        }
      ]
    },
    {
      "name": "registerCopier",
      "docs": [
        "Last instruction of the launch tx: checks the fee-sharing split",
        "`[target trader_bps, vault 10000 − trader_bps]` is final and creates the copier."
      ],
      "discriminator": [
        129,
        9,
        69,
        218,
        155,
        139,
        238,
        218
      ],
      "accounts": [
        {
          "name": "launcher",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "bondingCurve"
        },
        {
          "name": "sharingConfig"
        },
        {
          "name": "target"
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "copier",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  112,
                  105,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "traderBps",
          "type": "u16"
        }
      ]
    },
    {
      "name": "registerIndex",
      "docs": [
        "Admin: an index copier (vault takes 100% of creator fees) copying up to 16 wallets."
      ],
      "discriminator": [
        236,
        137,
        25,
        129,
        33,
        119,
        102,
        44
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "bondingCurve"
        },
        {
          "name": "sharingConfig"
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "copier",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  112,
                  105,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "targets",
          "type": {
            "vec": "pubkey"
          }
        }
      ]
    },
    {
      "name": "setPlatformMint",
      "docs": [
        "Once: names the registered Index copier whose coin is the platform token."
      ],
      "discriminator": [
        61,
        192,
        252,
        228,
        36,
        149,
        141,
        59
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "copier",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  112,
                  105,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "copier.mint",
                "account": "copier"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "mint",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "sync",
      "docs": [
        "Books lamports that reached the vault without the program (creator fees) as fee income."
      ],
      "discriminator": [
        4,
        219,
        40,
        164,
        21,
        157,
        189,
        88
      ],
      "accounts": [
        {
          "name": "copier",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  112,
                  105,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "copier.mint",
                "account": "copier"
              }
            ]
          }
        },
        {
          "name": "vault",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "copier.mint",
                "account": "copier"
              }
            ]
          }
        },
        {
          "name": "vaultWsol"
        }
      ],
      "args": []
    },
    {
      "name": "unverifyTrader",
      "discriminator": [
        39,
        92,
        133,
        128,
        179,
        199,
        239,
        255
      ],
      "accounts": [
        {
          "name": "target",
          "signer": true
        },
        {
          "name": "copier",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  112,
                  105,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "copier.mint",
                "account": "copier"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "targetIdx",
          "type": "u8"
        }
      ]
    },
    {
      "name": "verifyTrader",
      "discriminator": [
        19,
        110,
        57,
        187,
        114,
        218,
        133,
        240
      ],
      "accounts": [
        {
          "name": "target",
          "signer": true
        },
        {
          "name": "copier",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  112,
                  105,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "copier.mint",
                "account": "copier"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "targetIdx",
          "type": "u8"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "config",
      "discriminator": [
        155,
        12,
        170,
        224,
        30,
        250,
        204,
        130
      ]
    },
    {
      "name": "copier",
      "discriminator": [
        191,
        101,
        65,
        98,
        153,
        22,
        173,
        6
      ]
    },
    {
      "name": "pendingChange",
      "discriminator": [
        232,
        183,
        176,
        196,
        15,
        195,
        115,
        147
      ]
    },
    {
      "name": "position",
      "discriminator": [
        170,
        188,
        143,
        228,
        122,
        64,
        247,
        208
      ]
    }
  ],
  "events": [
    {
      "name": "buybackBurned",
      "discriminator": [
        186,
        84,
        241,
        202,
        152,
        185,
        0,
        115
      ]
    },
    {
      "name": "changeCancelled",
      "discriminator": [
        139,
        179,
        97,
        81,
        214,
        21,
        119,
        93
      ]
    },
    {
      "name": "changeDiscarded",
      "discriminator": [
        217,
        50,
        230,
        94,
        150,
        101,
        130,
        139
      ]
    },
    {
      "name": "changeExecuted",
      "discriminator": [
        50,
        115,
        8,
        12,
        139,
        8,
        191,
        26
      ]
    },
    {
      "name": "changeInvalidated",
      "discriminator": [
        122,
        154,
        108,
        124,
        90,
        117,
        46,
        244
      ]
    },
    {
      "name": "changeProposed",
      "discriminator": [
        170,
        10,
        10,
        8,
        244,
        196,
        146,
        151
      ]
    },
    {
      "name": "copierBuy",
      "discriminator": [
        247,
        0,
        7,
        73,
        43,
        156,
        101,
        17
      ]
    },
    {
      "name": "copierRegistered",
      "discriminator": [
        181,
        213,
        160,
        176,
        156,
        125,
        188,
        88
      ]
    },
    {
      "name": "copierSell",
      "discriminator": [
        73,
        29,
        246,
        147,
        113,
        245,
        247,
        152
      ]
    },
    {
      "name": "deposited",
      "discriminator": [
        111,
        141,
        26,
        45,
        161,
        35,
        100,
        57
      ]
    },
    {
      "name": "feesSynced",
      "discriminator": [
        41,
        98,
        204,
        192,
        243,
        3,
        53,
        218
      ]
    },
    {
      "name": "indexTargetsSet",
      "discriminator": [
        222,
        193,
        110,
        5,
        23,
        152,
        127,
        96
      ]
    },
    {
      "name": "keeperPaused",
      "discriminator": [
        252,
        14,
        240,
        37,
        119,
        137,
        145,
        167
      ]
    },
    {
      "name": "paramsUpdated",
      "discriminator": [
        2,
        163,
        138,
        99,
        135,
        11,
        136,
        169
      ]
    },
    {
      "name": "platformBurned",
      "discriminator": [
        107,
        141,
        79,
        19,
        134,
        83,
        255,
        101
      ]
    },
    {
      "name": "profitSplit",
      "discriminator": [
        148,
        113,
        189,
        160,
        79,
        151,
        232,
        187
      ]
    },
    {
      "name": "traderVerified",
      "discriminator": [
        48,
        45,
        155,
        166,
        48,
        166,
        196,
        79
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "notUpgradeAuthority",
      "msg": "Signer is not the program upgrade authority"
    },
    {
      "code": 6001,
      "name": "notAdmin",
      "msg": "Signer is not the config admin"
    },
    {
      "code": 6002,
      "name": "notPendingAdmin",
      "msg": "Signer is not the pending admin"
    },
    {
      "code": 6003,
      "name": "notKeeper",
      "msg": "Signer is not the keeper"
    },
    {
      "code": 6004,
      "name": "paramOutOfRange",
      "msg": "Parameter outside its allowed range"
    },
    {
      "code": 6005,
      "name": "tooManyDescriptors",
      "msg": "Too many trade descriptors"
    },
    {
      "code": 6006,
      "name": "descriptorProgramNotAllowed",
      "msg": "Descriptor targets a program other than pump or pump_amm"
    },
    {
      "code": 6007,
      "name": "descriptorDiscForbidden",
      "msg": "Descriptor discriminator is never allowed (create/extend/volume accumulator/migrate/deposit/withdraw/admin)"
    },
    {
      "code": 6008,
      "name": "descriptorIndices",
      "msg": "Descriptor account indices are inconsistent or min_accounts exceeds 40"
    },
    {
      "code": 6009,
      "name": "platformMintAlreadySet",
      "msg": "the platform token mint already set"
    },
    {
      "code": 6010,
      "name": "platformMintNotIndex",
      "msg": "the platform token mint must be a registered Index copier"
    },
    {
      "code": 6011,
      "name": "descriptorsIncomplete",
      "msg": "Descriptors must keep at least one Buy and one Sell descriptor for both the curve and the pool"
    },
    {
      "code": 6012,
      "name": "timelockOutOfRange",
      "msg": "Timelock must be between 60 seconds and 7 days"
    },
    {
      "code": 6013,
      "name": "timelockNotElapsed",
      "msg": "The change's timelock has not elapsed"
    },
    {
      "code": 6014,
      "name": "pendingChangeInvalid",
      "msg": "Pending change payload does not match its kind or accounts"
    },
    {
      "code": 6015,
      "name": "traderBpsOutOfRange",
      "msg": "Trader cut must be between 100 and 2500 bps"
    },
    {
      "code": 6016,
      "name": "sharingConfigMismatch",
      "msg": "Sharing config is not the canonical pump_fees PDA for this mint"
    },
    {
      "code": 6017,
      "name": "sharingConfigInvalid",
      "msg": "Sharing config account is not a pump_fees SharingConfig"
    },
    {
      "code": 6018,
      "name": "sharingConfigVersion",
      "msg": "Sharing config version must be 2"
    },
    {
      "code": 6019,
      "name": "sharingConfigNotActive",
      "msg": "Sharing config is not active"
    },
    {
      "code": 6020,
      "name": "sharingConfigAdminNotRevoked",
      "msg": "Sharing config admin is not revoked (split not immutable)"
    },
    {
      "code": 6021,
      "name": "shareholdersMismatch",
      "msg": "Shareholders must be exactly [target X, vault 10000-X] (index: [vault 10000])"
    },
    {
      "code": 6022,
      "name": "bondingCurveMismatch",
      "msg": "Bonding curve is not the canonical pump PDA for this mint"
    },
    {
      "code": 6023,
      "name": "bondingCurveInvalid",
      "msg": "Bonding curve account is not a pump BondingCurve"
    },
    {
      "code": 6024,
      "name": "creatorNotSharingConfig",
      "msg": "Bonding curve creator is not the sharing config"
    },
    {
      "code": 6025,
      "name": "curveComplete",
      "msg": "Bonding curve already complete"
    },
    {
      "code": 6026,
      "name": "mayhemCoin",
      "msg": "Mayhem-mode coins are not supported"
    },
    {
      "code": 6027,
      "name": "cashbackCoin",
      "msg": "Cashback coins are not supported"
    },
    {
      "code": 6028,
      "name": "holderRewardCoin",
      "msg": "Holder-reward coins are not supported"
    },
    {
      "code": 6029,
      "name": "notSolQuoted",
      "msg": "Only SOL-quoted coins are supported"
    },
    {
      "code": 6030,
      "name": "mintNotToken2022",
      "msg": "Mint is not a Token-2022 mint"
    },
    {
      "code": 6031,
      "name": "mintUnsafe",
      "msg": "Mint has an authority or an extension that could block transfers or burns"
    },
    {
      "code": 6032,
      "name": "targetInvalid",
      "msg": "Target must be a system-owned, non-executable wallet"
    },
    {
      "code": 6033,
      "name": "vaultInvalid",
      "msg": "Vault must be the system-owned, zero-data vault PDA"
    },
    {
      "code": 6034,
      "name": "invalidTargets",
      "msg": "Index target list is empty, too long or has duplicates"
    },
    {
      "code": 6035,
      "name": "notIndex",
      "msg": "Not an Index copier"
    },
    {
      "code": 6036,
      "name": "targetHasOpenPositions",
      "msg": "Cannot remove a target that still has open positions"
    },
    {
      "code": 6037,
      "name": "targetIndex",
      "msg": "Target index out of range"
    },
    {
      "code": 6038,
      "name": "targetMismatch",
      "msg": "Target account does not match the copier's target"
    },
    {
      "code": 6039,
      "name": "targetTokenAccount",
      "msg": "Target token account is not the canonical ATA"
    },
    {
      "code": 6040,
      "name": "descriptorIndex",
      "msg": "Descriptor index out of range"
    },
    {
      "code": 6041,
      "name": "descriptorSide",
      "msg": "Descriptor side does not match the instruction"
    },
    {
      "code": 6042,
      "name": "discriminatorMismatch",
      "msg": "Instruction data does not start with the descriptor's discriminator"
    },
    {
      "code": 6043,
      "name": "notEnoughAccounts",
      "msg": "Not enough venue accounts for this descriptor"
    },
    {
      "code": 6044,
      "name": "venueProgram",
      "msg": "Venue program account missing or not the descriptor's program"
    },
    {
      "code": 6045,
      "name": "userMismatch",
      "msg": "remaining[user_idx] is not the trading PDA"
    },
    {
      "code": 6046,
      "name": "userElsewhere",
      "msg": "The trading PDA appears in the venue accounts outside user_idx"
    },
    {
      "code": 6047,
      "name": "mintMismatch",
      "msg": "remaining[base_mint_idx] is not the traded mint"
    },
    {
      "code": 6048,
      "name": "venueMismatch",
      "msg": "Venue account is not the canonical bonding curve / pool for the mint"
    },
    {
      "code": 6049,
      "name": "venueInvalid",
      "msg": "Venue account is invalid, not SOL-quoted, mayhem or the wrong kind"
    },
    {
      "code": 6050,
      "name": "foreignVaultTokenAccount",
      "msg": "A writable token account owned by the trading PDA is not the traded mint / wSOL account"
    },
    {
      "code": 6051,
      "name": "ownMint",
      "msg": "Cannot copy-trade the copier's own coin"
    },
    {
      "code": 6052,
      "name": "noTargetIncrease",
      "msg": "Target balance did not increase"
    },
    {
      "code": 6053,
      "name": "signalTooSmall",
      "msg": "Target buy is below the minimum signal"
    },
    {
      "code": 6054,
      "name": "exceedsSignal",
      "msg": "Trade exceeds signal x signal_multiple"
    },
    {
      "code": 6055,
      "name": "exceedsTradeCap",
      "msg": "Trade exceeds max_trade_bps of equity"
    },
    {
      "code": 6056,
      "name": "exceedsPositionCap",
      "msg": "Position would exceed max_position_bps of equity"
    },
    {
      "code": 6057,
      "name": "exceedsImpact",
      "msg": "Trade exceeds max_impact_bps of the venue's real quote reserves"
    },
    {
      "code": 6058,
      "name": "tradeTooSmall",
      "msg": "Trade below min_trade_lamports"
    },
    {
      "code": 6059,
      "name": "belowVaultFloor",
      "msg": "Trade would take free SOL below the vault floor"
    },
    {
      "code": 6060,
      "name": "tooManyPositions",
      "msg": "Too many open positions"
    },
    {
      "code": 6061,
      "name": "positionTargetMismatch",
      "msg": "Position belongs to another target"
    },
    {
      "code": 6062,
      "name": "positionInvalid",
      "msg": "Position account is invalid"
    },
    {
      "code": 6063,
      "name": "noPosition",
      "msg": "No open position for this mint"
    },
    {
      "code": 6064,
      "name": "slippageTokens",
      "msg": "Venue returned fewer tokens than the floor"
    },
    {
      "code": 6065,
      "name": "slippageSol",
      "msg": "Venue returned less SOL than the floor"
    },
    {
      "code": 6066,
      "name": "overspent",
      "msg": "Venue spent more than sol_in plus the rent allowance"
    },
    {
      "code": 6067,
      "name": "sellAmountMismatch",
      "msg": "Venue sold a different amount of tokens than tokens_in"
    },
    {
      "code": 6068,
      "name": "sellNotAllowed",
      "msg": "Sell exceeds the target-proportional allowance"
    },
    {
      "code": 6069,
      "name": "sellNotPermitted",
      "msg": "Only the keeper may sell before the grace period ends while the target holds tokens"
    },
    {
      "code": 6070,
      "name": "zeroAmount",
      "msg": "Amount must be greater than zero"
    },
    {
      "code": 6071,
      "name": "exceedsBuybackPool",
      "msg": "Exceeds the buyback pool"
    },
    {
      "code": 6072,
      "name": "buybackTooSoon",
      "msg": "buyback_burn called again within 60 seconds"
    },
    {
      "code": 6073,
      "name": "exceedsBurnPool",
      "msg": "Burn pool does not hold enough SOL"
    },
    {
      "code": 6074,
      "name": "platformMintNotSet",
      "msg": "the platform token mint not set"
    },
    {
      "code": 6075,
      "name": "accountingBroken",
      "msg": "Vault balance is below what the program accounted (lamports left without the program)"
    },
    {
      "code": 6076,
      "name": "tokenAccountMismatch",
      "msg": "Token account is not the canonical ATA"
    },
    {
      "code": 6077,
      "name": "venueTouchedInTx",
      "msg": "Another instruction in this transaction touches a venue or is not allowed next to a copy-vault trade"
    },
    {
      "code": 6078,
      "name": "notTopLevel",
      "msg": "copy-vault trades must be top-level instructions, not CPIs"
    },
    {
      "code": 6079,
      "name": "spendWindowExceeded",
      "msg": "Buy would exceed the copier's spend limit for the current window"
    },
    {
      "code": 6080,
      "name": "publicSellRateLimited",
      "msg": "Only one permissionless sell per copier per slot"
    },
    {
      "code": 6081,
      "name": "platformBurnTooSoon",
      "msg": "burn_platform called again within 60 seconds"
    },
    {
      "code": 6082,
      "name": "mathOverflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6083,
      "name": "pendingChangeSuperseded",
      "msg": "A newer proposal of the same kind (or a keeper pause / admin handover) replaced this change"
    },
    {
      "code": 6084,
      "name": "pendingChangeExpired",
      "msg": "The change's execution window has passed"
    },
    {
      "code": 6085,
      "name": "pendingChangeLive",
      "msg": "The change is neither superseded nor expired"
    },
    {
      "code": 6086,
      "name": "descriptorsDropProvenExit",
      "msg": "Each venue must keep a Sell descriptor identical to a proven one of the current list"
    }
  ],
  "types": [
    {
      "name": "buybackBurned",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "solIn",
            "type": "u64"
          },
          {
            "name": "tokensBurned",
            "type": "u64"
          },
          {
            "name": "totalBurned",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "changeCancelled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "id",
            "type": "u64"
          },
          {
            "name": "kind",
            "type": {
              "defined": {
                "name": "changeKind"
              }
            }
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "changeDiscarded",
      "docs": [
        "A superseded or expired change's account was closed (`discard_pending`, permissionless)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "id",
            "type": "u64"
          },
          {
            "name": "kind",
            "type": {
              "defined": {
                "name": "changeKind"
              }
            }
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "changeExecuted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "id",
            "type": "u64"
          },
          {
            "name": "kind",
            "type": {
              "defined": {
                "name": "changeKind"
              }
            }
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "changeInvalidated",
      "docs": [
        "Change `id` can no longer execute (a newer proposal of its kind, a keeper pause or an admin",
        "handover). Its account stays until `discard_pending` / `cancel_pending`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "id",
            "type": "u64"
          },
          {
            "name": "kind",
            "type": {
              "defined": {
                "name": "changeKind"
              }
            }
          },
          {
            "name": "reason",
            "type": {
              "defined": {
                "name": "invalidationReason"
              }
            }
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "changeKind",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "keeper"
          },
          {
            "name": "params"
          },
          {
            "name": "descriptors"
          },
          {
            "name": "indexTargets"
          }
        ]
      }
    },
    {
      "name": "changeProposed",
      "docs": [
        "An admin change was queued (`propose_*`); executable by anyone from `eta` until `expires_at`",
        "unless superseded first."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "id",
            "type": "u64"
          },
          {
            "name": "kind",
            "type": {
              "defined": {
                "name": "changeKind"
              }
            }
          },
          {
            "name": "eta",
            "type": "i64"
          },
          {
            "name": "expiresAt",
            "type": "i64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "config",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "pendingAdmin",
            "type": "pubkey"
          },
          {
            "name": "keeper",
            "type": "pubkey"
          },
          {
            "name": "platformMint",
            "docs": [
              "the platform token; `Pubkey::default()` until `set_platform_mint` (once)."
            ],
            "type": "pubkey"
          },
          {
            "name": "params",
            "type": {
              "defined": {
                "name": "params"
              }
            }
          },
          {
            "name": "descriptors",
            "type": {
              "vec": {
                "defined": {
                  "name": "tradeDescriptor"
                }
              }
            }
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "burnPoolBump",
            "type": "u8"
          },
          {
            "name": "platformBurned",
            "docs": [
              "the platform token tokens the burn pool bought and burned (`burn_platform`)."
            ],
            "type": "u64"
          },
          {
            "name": "platformBurnSpent",
            "docs": [
              "Lamports the burn pool spent on those buys."
            ],
            "type": "u64"
          },
          {
            "name": "timelockSecs",
            "docs": [
              "Seconds between an admin proposal and its earliest execution (fixed at initialization)."
            ],
            "type": "i64"
          },
          {
            "name": "nextChangeId",
            "docs": [
              "Id of the next `PendingChange`."
            ],
            "type": "u64"
          },
          {
            "name": "pendingAdminEta",
            "docs": [
              "Earliest time `accept_admin` may run for `pending_admin`."
            ],
            "type": "i64"
          },
          {
            "name": "keeperHeartbeatTs",
            "docs": [
              "Last keeper-signed instruction (any trade, burn or `keeper_heartbeat`)."
            ],
            "type": "i64"
          },
          {
            "name": "lastPlatformBurnTs",
            "docs": [
              "Last `burn_platform`."
            ],
            "type": "i64"
          },
          {
            "name": "latestChangeIds",
            "docs": [
              "Per `ChangeKind` (in enum order): the id of the only proposal of that kind that may",
              "execute, or `NO_CHANGE`. A newer proposal supersedes the older one; `pause_keeper` clears the",
              "Keeper entry, `accept_admin` clears all of them."
            ],
            "type": {
              "array": [
                "u64",
                4
              ]
            }
          },
          {
            "name": "descriptorsProven",
            "docs": [
              "Bit i: `descriptors[i]` is proven (seeded, or a trade through it succeeded)."
            ],
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "copier",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "launcher",
            "type": "pubkey"
          },
          {
            "name": "kind",
            "type": {
              "defined": {
                "name": "copierKind"
              }
            }
          },
          {
            "name": "targets",
            "type": {
              "vec": "pubkey"
            }
          },
          {
            "name": "traderBps",
            "type": "u16"
          },
          {
            "name": "verified",
            "docs": [
              "Bit i set: targets[i] signed `verify_trader`."
            ],
            "type": "u16"
          },
          {
            "name": "vaultBump",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "sharingConfig",
            "type": "pubkey"
          },
          {
            "name": "accountedLamports",
            "docs": [
              "Vault lamports + vault wSOL the program knows about; anything above is fee income (`sync`)."
            ],
            "type": "u64"
          },
          {
            "name": "feesIn",
            "type": "u64"
          },
          {
            "name": "capitalIn",
            "type": "u64"
          },
          {
            "name": "openCost",
            "docs": [
              "Cost basis of all open positions (lamports, rent included)."
            ],
            "type": "u64"
          },
          {
            "name": "openPositions",
            "type": "u8"
          },
          {
            "name": "realizedPnl",
            "type": "i64"
          },
          {
            "name": "hwm",
            "type": "i64"
          },
          {
            "name": "buybackPool",
            "docs": [
              "Earmarked for buying back & burning the copier's own coin (75% of profit above the HWM)."
            ],
            "type": "u64"
          },
          {
            "name": "platformSent",
            "docs": [
              "Lamports sent to the platform token burn pool (25% of profit above the HWM)."
            ],
            "type": "u64"
          },
          {
            "name": "burned",
            "docs": [
              "Own-coin tokens bought back and burned."
            ],
            "type": "u64"
          },
          {
            "name": "buybackSpent",
            "docs": [
              "Lamports spent on own-coin buybacks."
            ],
            "type": "u64"
          },
          {
            "name": "trades",
            "type": "u64"
          },
          {
            "name": "lastKeeperTs",
            "type": "i64"
          },
          {
            "name": "graduatedPool",
            "docs": [
              "Canonical PumpSwap pool of the own coin once a buyback has seen it graduated."
            ],
            "type": "pubkey"
          },
          {
            "name": "platformPending",
            "docs": [
              "the platform token share not yet moved to the burn pool (`fund_platform_burn`)."
            ],
            "type": "u64"
          },
          {
            "name": "lastBuybackTs",
            "type": "i64"
          },
          {
            "name": "targetPositions",
            "docs": [
              "Open positions per target index (parallel to `targets`)."
            ],
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          },
          {
            "name": "windowStart",
            "docs": [
              "Start of the current buy spend window."
            ],
            "type": "i64"
          },
          {
            "name": "windowSpent",
            "docs": [
              "Lamports `copier_buy` spent in the current window."
            ],
            "type": "u64"
          },
          {
            "name": "windowEquity",
            "docs": [
              "Equity at the start of the current window (the window cap's base)."
            ],
            "type": "u64"
          },
          {
            "name": "lastPublicSellSlot",
            "docs": [
              "Slot of the last permissionless `copier_sell` (one slice per slot)."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "copierBuy",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "target",
            "type": "pubkey"
          },
          {
            "name": "tokenMint",
            "type": "pubkey"
          },
          {
            "name": "venue",
            "type": {
              "defined": {
                "name": "venue"
              }
            }
          },
          {
            "name": "solIn",
            "docs": [
              "Lamports the buy cost the vault (venue spend plus any rent it paid), booked as cost."
            ],
            "type": "u64"
          },
          {
            "name": "tokensOut",
            "type": "u64"
          },
          {
            "name": "targetBalance",
            "type": "u64"
          },
          {
            "name": "signalLamports",
            "type": "u64"
          },
          {
            "name": "equity",
            "docs": [
              "Vault equity before the buy."
            ],
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "copierKind",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "single"
          },
          {
            "name": "index"
          }
        ]
      }
    },
    {
      "name": "copierRegistered",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "launcher",
            "type": "pubkey"
          },
          {
            "name": "kind",
            "type": {
              "defined": {
                "name": "copierKind"
              }
            }
          },
          {
            "name": "targets",
            "type": {
              "vec": "pubkey"
            }
          },
          {
            "name": "traderBps",
            "type": "u16"
          },
          {
            "name": "sharingConfig",
            "type": "pubkey"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "copierSell",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "target",
            "type": "pubkey"
          },
          {
            "name": "tokenMint",
            "type": "pubkey"
          },
          {
            "name": "venue",
            "type": {
              "defined": {
                "name": "venue"
              }
            }
          },
          {
            "name": "tokensIn",
            "type": "u64"
          },
          {
            "name": "solOut",
            "docs": [
              "Lamports back on the vault: venue proceeds plus rent refunded on a closing sell."
            ],
            "type": "u64"
          },
          {
            "name": "costRemoved",
            "type": "u64"
          },
          {
            "name": "pnl",
            "type": "i64"
          },
          {
            "name": "realizedPnl",
            "type": "i64"
          },
          {
            "name": "hwm",
            "type": "i64"
          },
          {
            "name": "forced",
            "docs": [
              "Exit by max-hold or by a non-keeper after the keeper grace period."
            ],
            "type": "bool"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "deposited",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "from",
            "type": "pubkey"
          },
          {
            "name": "lamports",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "feesSynced",
      "docs": [
        "Lamports found on the vault that the program did not move itself (creator fees)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "lamports",
            "type": "u64"
          },
          {
            "name": "total",
            "docs": [
              "`fees_in` after booking."
            ],
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "indexTargetsSet",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "targets",
            "type": {
              "vec": "pubkey"
            }
          }
        ]
      }
    },
    {
      "name": "invalidationReason",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "superseded"
          },
          {
            "name": "keeperPaused"
          },
          {
            "name": "adminChanged"
          }
        ]
      }
    },
    {
      "name": "keeperPaused",
      "docs": [
        "The admin removed the keeper instantly (`pause_keeper`); a new one needs a timelocked",
        "`propose_keeper`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "keeper",
            "type": "pubkey"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "params",
      "docs": [
        "Admin-settable trading parameters; `validate` enforces the two-sided ranges in",
        "`constants.rs`. Changed only through the timelocked `propose_params` → `execute_pending`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "maxTradeBps",
            "docs": [
              "Max lamports per buy, in bps of vault equity."
            ],
            "type": "u16"
          },
          {
            "name": "maxPositionBps",
            "docs": [
              "Max cost basis per traded mint, in bps of vault equity."
            ],
            "type": "u16"
          },
          {
            "name": "maxOpenPositions",
            "type": "u8"
          },
          {
            "name": "minTradeLamports",
            "type": "u64"
          },
          {
            "name": "minSignalLamports",
            "docs": [
              "Min (target token increase × spot price) for a buy to count as a signal."
            ],
            "type": "u64"
          },
          {
            "name": "signalMultipleBps",
            "docs": [
              "A vault buy may spend at most this multiple (bps) of the signal."
            ],
            "type": "u16"
          },
          {
            "name": "maxImpactBps",
            "docs": [
              "Max lamports per buy in bps of the venue's real quote reserves."
            ],
            "type": "u16"
          },
          {
            "name": "slippageBps",
            "docs": [
              "Program-side floor: fills must reach (10000 − slippage_bps) of the fee-free quote."
            ],
            "type": "u16"
          },
          {
            "name": "vaultFloorLamports",
            "docs": [
              "Free SOL a buy may never spend below."
            ],
            "type": "u64"
          },
          {
            "name": "maxHoldSecs",
            "docs": [
              "After this long a position may be exited regardless of the target."
            ],
            "type": "i64"
          },
          {
            "name": "keeperGraceSecs",
            "docs": [
              "After this long without a keeper heartbeat (`Config.keeper_heartbeat_ts`), exits are",
              "permissionless for positions whose target holds 0, in impact-capped slices."
            ],
            "type": "i64"
          },
          {
            "name": "spendWindowSecs",
            "docs": [
              "Length of a copier's buy spend window."
            ],
            "type": "i64"
          },
          {
            "name": "maxWindowSpendBps",
            "docs": [
              "Max lamports `copier_buy` may spend per window, in bps of equity at the window's start."
            ],
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "paramsUpdated",
      "docs": [
        "Any config change (params, keeper, descriptors, admin handover, the platform token mint)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "params",
            "type": {
              "defined": {
                "name": "params"
              }
            }
          },
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "pendingAdmin",
            "type": "pubkey"
          },
          {
            "name": "keeper",
            "type": "pubkey"
          },
          {
            "name": "platformMint",
            "type": "pubkey"
          },
          {
            "name": "descriptors",
            "type": "u8"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "pendingChange",
      "docs": [
        "A timelocked admin change `[\"pending\", id]`. Anyone may execute it from `eta` to `expires_at`",
        "while it is still the live proposal of its kind (`Config.latest_change_ids[kind] == id`); a newer",
        "proposal of the same kind, `pause_keeper` (Keeper changes) or `accept_admin` (all) supersede",
        "it. Status for indexers: superseded if not the live id, expired after `expires_at`, queued",
        "before `eta`, executable otherwise. The admin may cancel it; anyone may discard it once",
        "superseded or expired. Only the payload field of its `kind` is meaningful."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "id",
            "type": "u64"
          },
          {
            "name": "kind",
            "type": {
              "defined": {
                "name": "changeKind"
              }
            }
          },
          {
            "name": "proposer",
            "type": "pubkey"
          },
          {
            "name": "proposedAt",
            "type": "i64"
          },
          {
            "name": "eta",
            "type": "i64"
          },
          {
            "name": "expiresAt",
            "docs": [
              "Last moment it can execute (`eta + EXECUTE_WINDOW_SECS`)."
            ],
            "type": "i64"
          },
          {
            "name": "keeper",
            "type": "pubkey"
          },
          {
            "name": "params",
            "type": {
              "defined": {
                "name": "params"
              }
            }
          },
          {
            "name": "descriptors",
            "type": {
              "vec": {
                "defined": {
                  "name": "tradeDescriptor"
                }
              }
            }
          },
          {
            "name": "copier",
            "docs": [
              "The Index copier whose targets change (`IndexTargets`)."
            ],
            "type": "pubkey"
          },
          {
            "name": "targets",
            "type": {
              "vec": "pubkey"
            }
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "platformBurned",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "solIn",
            "type": "u64"
          },
          {
            "name": "tokensBurned",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "position",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "docs": [
              "The copier's mint."
            ],
            "type": "pubkey"
          },
          {
            "name": "tokenMint",
            "docs": [
              "The traded coin."
            ],
            "type": "pubkey"
          },
          {
            "name": "target",
            "docs": [
              "The target this position copies."
            ],
            "type": "pubkey"
          },
          {
            "name": "tokens",
            "type": "u64"
          },
          {
            "name": "cost",
            "docs": [
              "Cost basis (lamports spent, rent included)."
            ],
            "type": "u64"
          },
          {
            "name": "targetSnapshot",
            "docs": [
              "Target's balance after the last copied trade."
            ],
            "type": "u64"
          },
          {
            "name": "targetPeak",
            "docs": [
              "Target's balance at the last vault buy; with `vault_peak` sets the proportional sell."
            ],
            "type": "u64"
          },
          {
            "name": "vaultPeak",
            "type": "u64"
          },
          {
            "name": "openedAt",
            "type": "i64"
          },
          {
            "name": "lastTradeTs",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "profitSplit",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "excess",
            "type": "u64"
          },
          {
            "name": "toBuyback",
            "type": "u64"
          },
          {
            "name": "toPlatform",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "side",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "buy"
          },
          {
            "name": "sell"
          }
        ]
      }
    },
    {
      "name": "tradeDescriptor",
      "docs": [
        "One whitelisted venue instruction. The keeper forwards that instruction's exact account list",
        "as remaining accounts and its full data (discriminator included); the program checks the roles",
        "below, signs as `remaining[user_idx]` and measures the fill from balance deltas."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "program",
            "docs": [
              "pump or pump_amm only."
            ],
            "type": "pubkey"
          },
          {
            "name": "disc",
            "type": {
              "array": [
                "u8",
                8
              ]
            }
          },
          {
            "name": "side",
            "type": {
              "defined": {
                "name": "side"
              }
            }
          },
          {
            "name": "venue",
            "type": {
              "defined": {
                "name": "venue"
              }
            }
          },
          {
            "name": "userIdx",
            "type": "u8"
          },
          {
            "name": "baseMintIdx",
            "type": "u8"
          },
          {
            "name": "venueIdx",
            "type": "u8"
          },
          {
            "name": "minAccounts",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "traderVerified",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "target",
            "type": "pubkey"
          },
          {
            "name": "verified",
            "type": "bool"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "venue",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "curve"
          },
          {
            "name": "pool"
          }
        ]
      }
    }
  ]
};
