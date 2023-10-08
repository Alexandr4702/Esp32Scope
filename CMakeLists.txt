# The following lines of boilerplate have to be in your project's CMakeLists
# in this exact order for cmake to work correctly
cmake_minimum_required(VERSION 3.16)

set(PROTO_FILE ${CMAKE_CURRENT_SOURCE_DIR}/main/proto/wsInterface.proto)
set(GENERATED_DIR ${CMAKE_CURRENT_SOURCE_DIR}/main/proto/)
set(PROTO_PATH ${CMAKE_CURRENT_SOURCE_DIR}/main/proto)

execute_process(
    COMMAND protoc
        --cpp_out=${GENERATED_DIR}
        --js_out=import_style=commonjs,binary:${GENERATED_DIR}
        --proto_path=${PROTO_PATH}
        --plugin=protoc-gen-js=c:\\msys64/mingw64/lib/node_modules/protoc-gen-js/bin/protoc-gen-js.exe
        ${PROTO_FILE}
    WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
)

set(EXTRA_COMPONENT_DIRS $ENV{IDF_PATH}/examples/common_components/protocol_examples_common)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(Esp32Scope)
