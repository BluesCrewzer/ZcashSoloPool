cmd_Release/equi.so := ln -f "Release/obj.target/equi.so" "Release/equi.so" 2>/dev/null || (rm -rf "Release/equi.so" && cp -af "Release/obj.target/equi.so" "Release/equi.so")
