cmake_minimum_required(VERSION 3.16)
project(nexus_navigation VERSION 0.1.0 LANGUAGES CXX)

include(GNUInstallDirs)

option(NEXUS_BUILD_TESTS "Build the dependency-free navigation tests" ON)

function(nexus_enable_warnings target)
  if(MSVC)
    target_compile_options(${target} PRIVATE /W4 /permissive-)
  elseif(CMAKE_CXX_COMPILER_ID MATCHES "^(GNU|Clang|AppleClang)$")
    target_compile_options(${target} PRIVATE -Wall -Wextra -Wpedantic)
  endif()
endfunction()

add_library(nexus_navigation STATIC
  src/occupancy_grid.cpp
)

target_include_directories(nexus_navigation
  PUBLIC
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
    $<INSTALL_INTERFACE:include>
)

target_compile_features(nexus_navigation PUBLIC cxx_std_17)
set_target_properties(nexus_navigation PROPERTIES CXX_EXTENSIONS OFF)
nexus_enable_warnings(nexus_navigation)

if(NEXUS_BUILD_TESTS)
  enable_testing()
  add_executable(nexus_navigation_tests tests/occupancy_grid_test.cpp)
  target_link_libraries(nexus_navigation_tests PRIVATE nexus_navigation)
  set_target_properties(nexus_navigation_tests PROPERTIES CXX_EXTENSIONS OFF)
  nexus_enable_warnings(nexus_navigation_tests)
  add_test(NAME nexus_navigation_tests COMMAND nexus_navigation_tests)
endif()

install(
  TARGETS nexus_navigation
  EXPORT nexus_navigationTargets
  ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR}
  LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR}
  RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR}
  INCLUDES DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}
)
install(DIRECTORY include/ DESTINATION ${CMAKE_INSTALL_INCLUDEDIR})
install(
  EXPORT nexus_navigationTargets
  FILE nexus_navigationTargets.cmake
  NAMESPACE nexus::
  DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/nexus_navigation
)
