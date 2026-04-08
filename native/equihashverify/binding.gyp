{
    "targets": [
        {
            "target_name": "equihashverify",
            "dependencies": [
                "libequi",
            ],
            "sources": [
                "equihashverify.cc",
            ],
            "include_dirs": [
                "<!(node -e \"require('nan')\")"
            ],
            "defines": [],
            "cflags_cc": [
                "-std=c++17",
                "-fPIC"
            ],
            "link_settings": {
                "libraries": [
                    "-lsodium"
                ]
            }
        },
        {
            "target_name": "libequi",
            "type": "<(library)",
            "dependencies": [
            ],
            "sources": [
                "src/equi/equi.c",
                "src/equi/endian.c"
            ],
            "include_dirs": [
            ],
            "defines": [
            ],
            "cflags_c": [
                "-std=c11",
                "-fPIC",
                "-Wno-pointer-sign",
                "-D_GNU_SOURCE"
            ],
            "link_settings": {
                "libraries": [
                    "-lsodium"
                ],
            },
        }
    ]
}

